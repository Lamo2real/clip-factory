//! What the page may hand the sign-in door, and what the door may take from the browser (docs/CONTRACTS.md §38.15).
//! Pure functions, so every rule has a unit test.
//!
//! * `authorize_url`: the one address `cr_connect_open` opens: Content Rewards' own sign-in page, with exactly the
//!   parameters the API builds (§38.9), each at most once, and a way back to this door's port only.
//! * `code_ok`, `state_ok`, `error_ok`, `description`, `iss_ok`: the parts of the answer the door passes on.
//! * `same`: compares the answer's `state` with the one the door opened, in constant time.

use tauri::Url;

/// Content Rewards' sign-in page. Nothing else is ever opened.
pub const AUTHORIZE: &str = "https://id.contentrewards.com/oauth2/authorize";
/// The one `resource` the sign-in may be for (no trailing slash).
pub const RESOURCE: &str = "https://mcp.contentrewards.com/mcp";
/// The most an address from the page may be.
const MAX_URL: usize = 4096;
/// The most a `state` may be (the API's signed state is far shorter).
pub const MAX_STATE: usize = 200;
/// The most a `code` from the browser may be.
pub const MAX_CODE: usize = 2048;
/// The most an `error` from the browser may be.
pub const MAX_ERROR: usize = 64;
/// What is kept of an `error_description`.
pub const MAX_DESCRIPTION: usize = 300;
/// The most an `iss` may be.
pub const MAX_ISS: usize = 200;
/// The most a `client_id` or a `scope` may be.
const MAX_CLIENT_ID: usize = 256;
const MAX_SCOPE: usize = 1024;

/// The parameters the API's address carries (§38.9). Any other name is refused.
const KNOWN: [&str; 8] = [
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
    "resource",
];

/// The address from the page was refused (the command answers `bad_url`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BadUrl;

/// A checked sign-in address: what to open, and the `state` the answer must carry back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authorize {
    pub url: String,
    pub state: String,
}

/// The way back the address must name: exactly this door, on this computer only.
pub fn redirect_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

/// Checks the address `cr_connect_open` was given for the door listening on `port`.
///
/// Only `https://id.contentrewards.com/oauth2/authorize` with no user info, no port and no `#`; every query
/// parameter at most once and none the API does not send; `response_type=code`, a `client_id`,
/// `code_challenge_method=S256`, a `code_challenge` of 43 base64url characters, exactly one
/// `resource=https://mcp.contentrewards.com/mcp`, a `state` (at most 200 of `[A-Za-z0-9._-]`) and `redirect_uri`
/// exactly `http://127.0.0.1:{port}/`. A `scope` may be there (the API sends one), at most once.
pub fn authorize_url(raw: &str, port: u16) -> Result<Authorize, BadUrl> {
    if raw.len() > MAX_URL {
        return Err(BadUrl);
    }
    // Written out as the API writes it, so user info, a port (even :443), another case or another path never
    // reach the parser's normalising.
    let prefix = format!("{AUTHORIZE}?");
    if !raw.starts_with(&prefix) || raw.contains('#') {
        return Err(BadUrl);
    }
    let url = Url::parse(raw).map_err(|_| BadUrl)?;
    if url.scheme() != "https"
        || url.host_str() != Some("id.contentrewards.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/oauth2/authorize"
        || url.fragment().is_some()
    {
        return Err(BadUrl);
    }

    let mut seen: Vec<(String, String)> = Vec::new();
    for (k, v) in url.query_pairs() {
        if !KNOWN.contains(&k.as_ref()) || seen.iter().any(|(name, _)| name == k.as_ref()) {
            return Err(BadUrl);
        }
        seen.push((k.into_owned(), v.into_owned()));
    }
    let get = |name: &str| {
        seen.iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };

    let client_ok = get("client_id").is_some_and(|c| {
        !c.is_empty() && c.len() <= MAX_CLIENT_ID && c.bytes().all(|b| b.is_ascii_graphic())
    });
    let scope_ok = get("scope").is_none_or(|s| {
        !s.is_empty()
            && s.len() <= MAX_SCOPE
            && s.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
    });
    let challenge_ok = get("code_challenge").is_some_and(|c| {
        c.len() == 43
            && c.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    });
    let state = get("state").filter(|s| state_ok(s)).ok_or(BadUrl)?;
    if get("response_type") != Some("code")
        || get("code_challenge_method") != Some("S256")
        || get("resource") != Some(RESOURCE)
        || get("redirect_uri") != Some(redirect_for(port).as_str())
        || !client_ok
        || !scope_ok
        || !challenge_ok
    {
        return Err(BadUrl);
    }
    Ok(Authorize {
        state: state.to_owned(),
        url: url.as_str().to_owned(),
    })
}

/// A `state`: 1 to 200 characters of `[A-Za-z0-9._-]`.
pub fn state_ok(state: &str) -> bool {
    !state.is_empty()
        && state.len() <= MAX_STATE
        && state
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// A `code`: 1 to 2,048 characters of `[A-Za-z0-9._~+/=-]`.
pub fn code_ok(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= MAX_CODE
        && code.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'-')
        })
}

/// An `error`: 1 to 64 characters of `[a-z_]`.
pub fn error_ok(error: &str) -> bool {
    !error.is_empty()
        && error.len() <= MAX_ERROR
        && error.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

/// An `error_description` as it is passed on: printable characters only, cut to 300.
pub fn description(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(MAX_DESCRIPTION)
        .collect()
}

/// An `iss`: 1 to 200 printable characters (an address, so plain ASCII with no spaces).
pub fn iss_ok(iss: &str) -> bool {
    !iss.is_empty() && iss.len() <= MAX_ISS && iss.bytes().all(|b| b.is_ascii_graphic())
}

/// Whether `a` and `b` are the same, taking as long whichever byte differs.
pub fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    pub const STATE: &str = "v1.cr.0123456789abcdef.1795264496.c2lnbmF0dXJl";

    /// The address the API builds (§38.9), with any of its parameters swapped or added.
    pub fn url_with(port: u16, change: &[(&str, Option<&str>)]) -> String {
        let redirect = redirect_for(port);
        let mut params: Vec<(String, String)> = [
            ("response_type", "code"),
            ("client_id", "clip-factory-client"),
            ("redirect_uri", redirect.as_str()),
            (
                "scope",
                "org:read campaigns:read submissions:read earnings:read my_submissions:write",
            ),
            ("state", STATE),
            ("code_challenge", CHALLENGE),
            ("code_challenge_method", "S256"),
            ("resource", RESOURCE),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        for (k, v) in change {
            params.retain(|(name, _)| name != k);
            if let Some(v) = v {
                params.push((k.to_string(), v.to_string()));
            }
        }
        let query: Vec<String> = params
            .iter()
            .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
            .collect();
        format!("{AUTHORIZE}?{}", query.join("&"))
    }

    pub fn enc(s: &str) -> String {
        s.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    }

    #[test]
    fn the_address_the_api_builds_is_taken_and_names_its_state() {
        let raw = url_with(47811, &[]);
        let ok = authorize_url(&raw, 47811).expect("the API's address");
        assert_eq!(ok.state, STATE);
        assert!(ok
            .url
            .starts_with("https://id.contentrewards.com/oauth2/authorize?"));
        // Without a scope too: the door does not need one.
        assert!(authorize_url(&url_with(47811, &[("scope", None)]), 47811).is_ok());
        // The parameters in another order.
        let swapped = format!(
            "{AUTHORIZE}?state={STATE}&resource={}&code_challenge_method=S256&code_challenge={CHALLENGE}\
             &redirect_uri={}&client_id=c&response_type=code",
            enc(RESOURCE),
            enc("http://127.0.0.1:47812/")
        );
        assert_eq!(authorize_url(&swapped, 47812).unwrap().state, STATE);
    }

    #[test]
    fn only_contentrewards_own_https_sign_in_page_is_opened() {
        let good = url_with(47811, &[]);
        let query = good.split_once('?').unwrap().1;
        for bad in [
            // http
            format!("http://id.contentrewards.com/oauth2/authorize?{query}"),
            // another host, a look-alike, a sub-host
            format!("https://contentrewards.com/oauth2/authorize?{query}"),
            format!("https://id.contentrewards.com.evil.test/oauth2/authorize?{query}"),
            format!("https://evil.id.contentrewards.com/oauth2/authorize?{query}"),
            format!("https://ID.contentrewards.com/oauth2/authorize?{query}"),
            // another path
            format!("https://id.contentrewards.com/oauth2/token?{query}"),
            format!("https://id.contentrewards.com/oauth2/authorize/?{query}"),
            format!("https://id.contentrewards.com/oauth2/./authorize?{query}"),
            // a port in the address, even the usual one
            format!("https://id.contentrewards.com:443/oauth2/authorize?{query}"),
            format!("https://id.contentrewards.com:8443/oauth2/authorize?{query}"),
            // user info
            format!("https://me@id.contentrewards.com/oauth2/authorize?{query}"),
            // a fragment
            format!("{good}#x"),
            // no query, other schemes, nothing
            AUTHORIZE.to_owned(),
            format!("javascript:alert(1)//{query}"),
            String::new(),
            // too long
            format!("{good}&{}", "x".repeat(MAX_URL)),
        ] {
            assert_eq!(authorize_url(&bad, 47811), Err(BadUrl), "{bad}");
        }
    }

    #[test]
    fn the_sign_in_must_be_pkce_s256_for_the_one_resource() {
        for change in [
            // no S256
            vec![("code_challenge_method", None)],
            vec![("code_challenge_method", Some("plain"))],
            vec![("code_challenge_method", Some("s256"))],
            // a short code_challenge, a long one, a bad character
            vec![("code_challenge", Some(&CHALLENGE[..42]))],
            vec![(
                "code_challenge",
                Some("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cMx"),
            )],
            vec![(
                "code_challenge",
                Some("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+cM"),
            )],
            vec![("code_challenge", None)],
            // another resource, a trailing slash, none
            vec![("resource", Some("https://mcp.contentrewards.com/mcp/"))],
            vec![("resource", Some("https://evil.test/mcp"))],
            vec![("resource", None)],
            // not a code flow
            vec![("response_type", Some("token"))],
            vec![("response_type", None)],
            // no client, a bad one
            vec![("client_id", None)],
            vec![("client_id", Some(""))],
            vec![("client_id", Some("a b"))],
            // an empty scope
            vec![("scope", Some(""))],
            // a parameter the API never sends
            vec![("prompt", Some("none"))],
            vec![("login_hint", Some("me@example.com"))],
        ] {
            let raw = url_with(47811, &change);
            assert_eq!(authorize_url(&raw, 47811), Err(BadUrl), "{change:?}");
        }
    }

    #[test]
    fn every_parameter_comes_once() {
        let good = url_with(47811, &[]);
        // Two resources (even the right one twice), a repeated state, a repeated way back.
        for extra in [
            format!("resource={}", enc(RESOURCE)),
            format!("state={STATE}"),
            "state=other".to_owned(),
            format!("redirect_uri={}", enc("http://127.0.0.1:47811/")),
            "response_type=code".to_owned(),
            // the same name written another way decodes to the same name
            format!("st%61te={STATE}"),
        ] {
            let raw = format!("{good}&{extra}");
            assert_eq!(authorize_url(&raw, 47811), Err(BadUrl), "{extra}");
        }
    }

    #[test]
    fn the_way_back_is_this_door_only() {
        // A redirect for another port, another host, https, a path, no slash, localhost.
        for redirect in [
            "http://127.0.0.1:47812/",
            "http://127.0.0.1:47811",
            "http://127.0.0.1:47811/cb",
            "https://127.0.0.1:47811/",
            "http://localhost:47811/",
            "http://[::1]:47811/",
            "http://0.0.0.0:47811/",
            "http://evil.test:47811/",
        ] {
            let raw = url_with(47811, &[("redirect_uri", Some(redirect))]);
            assert_eq!(authorize_url(&raw, 47811), Err(BadUrl), "{redirect}");
        }
        assert_eq!(
            authorize_url(&url_with(47811, &[("redirect_uri", None)]), 47811),
            Err(BadUrl)
        );
        // The same address is good for its own port only.
        assert_eq!(authorize_url(&url_with(47811, &[]), 47815), Err(BadUrl));
    }

    #[test]
    fn the_state_is_short_and_plain() {
        for bad in ["", "a b", "a/b", "a+b", "ä", &"s".repeat(MAX_STATE + 1)] {
            assert!(!state_ok(bad), "{bad}");
            let raw = url_with(47811, &[("state", Some(bad))]);
            assert_eq!(authorize_url(&raw, 47811), Err(BadUrl), "{bad}");
        }
        assert!(state_ok(&"s".repeat(MAX_STATE)));
        assert!(state_ok("A-z_0.9"));
        assert_eq!(
            authorize_url(&url_with(47811, &[("state", None)]), 47811),
            Err(BadUrl)
        );
    }

    #[test]
    fn the_answer_parts_are_checked() {
        assert!(code_ok("abc.DEF_123~+/=-"));
        assert!(code_ok(&"c".repeat(MAX_CODE)));
        for bad in [
            "",
            "a b",
            "a&b",
            "a<b",
            "a\nb",
            "é",
            &"c".repeat(MAX_CODE + 1),
        ] {
            assert!(!code_ok(bad), "{bad:?}");
        }
        assert!(error_ok("access_denied"));
        assert!(error_ok(&"e".repeat(MAX_ERROR)));
        for bad in [
            "",
            "Access_denied",
            "access-denied",
            "a b",
            &"e".repeat(MAX_ERROR + 1),
        ] {
            assert!(!error_ok(bad), "{bad:?}");
        }
        assert!(iss_ok("https://id.contentrewards.com"));
        assert!(iss_ok(&"i".repeat(MAX_ISS)));
        for bad in ["", "a b", "a\tb", "é", &"i".repeat(MAX_ISS + 1)] {
            assert!(!iss_ok(bad), "{bad:?}");
        }
        assert_eq!(description("Your account\ncan't\u{7}"), "Your accountcan't");
        assert_eq!(description(&"d".repeat(500)).len(), MAX_DESCRIPTION);
        assert_eq!(
            description(&"é".repeat(500)).chars().count(),
            MAX_DESCRIPTION
        );
    }

    #[test]
    fn states_are_compared_whole() {
        assert!(same(STATE, STATE));
        assert!(!same(STATE, &STATE[1..]));
        assert!(!same(STATE, &format!("{STATE}x")));
        assert!(!same("abc", "abd"));
        assert!(!same("", "a"));
    }
}

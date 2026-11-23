#!/usr/bin/env bash
# Clip Factory unchanged (docs/CONTRACTS.md §45.1, §45.15, §45.18; the owner's rule for Lamo Stories: "Clip Factory must
# stay exactly as it is"). Runs in deploy.yml after the delete gate, on the same saved plan, before anything is
# applied. Reads a Terraform plan as JSON (terraform show -json prod.tfplan) and names every change it would make to
# the pieces of Clip Factory that Lamo Stories sits next to:
#   - anything under module.agent. (Clip Factory's agent: its image, runtime, role, repository), created, changed or
#     deleted, unless Clip Factory's own agent image tag changed in this deploy (module.agent.terraform_data.image is
#     replaced, or created on a deploy from nothing);
#   - cf-prod-api's role or its policy, and its function in anything but source_code_hash, last_modified, version,
#     qualified_arn, qualified_invoke_arn and environment.variables.VERSION (this release's shared zip and git sha, as
#     on every deploy): never its handler, runtime, memory, timeout, role or any other environment key;
#   - the HTTP API itself, its JWT authorizer, cf-prod-api's invoke permission, and every existing route and
#     integration (new ones may be added; Lamo Stories' own may change); its stage only in the route settings of
#     Lamo Stories' own routes (the callback's throttle);
#   - cf-prod-hooks' role or policy, and its function in anything but the release attributes above and the one
#     environment key STORIES_OAUTH_CALLBACK (§45.15: the only Lamo Stories change there).
# And always, whatever else is decided below: a Lamo Stories route (module.api.aws_apigatewayv2_route.stories[...]) may
# only be one of its own paths, so it can never take over a Clip Factory path.
#
# Whose change is it? Clip Factory's own pull requests change these pieces all the time (an "off until its switch"
# env flag on cf-prod-api, a grant or a switch on its agent), and their push deploys must keep reaching production. So
# the findings stop the deploy only when Lamo Stories' work is in it. The commits on the first-parent line from the
# live release (cf-prod-api's VERSION before this plan, the git sha of the last applied deploy) to this one are read,
# one pull request (or pushed commit) each. A commit is Lamo Stories' when it touches its folders (stories/,
# web/src/stories/, infra/modules/stories_*, api/.../workspaces/, the story flow, its tests) or names it in its message
# ("Funded Clips", or an old name "Clip Stories", "Clip Factory Stories" or "Lamo Stories", any case); it matters here when it also
# touches what feeds this plan (infra/, deploy.yml, or Clip Factory's agent sources agent/, skills/, config/). With
# none, the findings are Clip Factory's own and are printed as notices.
# When the history cannot be read (no live release in the plan, a commit that is not here), they stop the deploy. A
# Lamo Stories commit that touches Clip Factory's agent sources is a finding of its own (§45.17: not touched at all),
# because it would also change Clip Factory's agent tag and so pass the module.agent rule.
#
# It prints addresses, attribute names, environment key names and commit subjects only, never a value.
#
# Usage: bash scripts/check-plan-clips-unchanged.sh plan.json
#   ALLOW_CLIPS_CHANGE=true  a run by hand with "Clip Factory changes on purpose" ticked (one deploy that carries both
#                            Lamo Stories' and a Clip Factory pull request's changes): the findings only warn. Never
#                            the route rule.
#   CLIPS_CHECK_GIT_DIR      the repository to read (default: the current folder; deploy.yml fetches its history first).
# Exit 0: nothing to stop. Exit 1: stopped (each finding is named, in plain words). Exit 2: the plan file is missing or
# is not a Terraform plan.
set -euo pipefail

plan="${1:-}"
if [ -z "$plan" ] || [ ! -f "$plan" ]; then
  echo "check-plan-clips-unchanged: give the path of the plan as JSON (terraform show -json prod.tfplan > plan.json)." >&2
  exit 2
fi
if ! jq -e 'has("resource_changes") or has("format_version")' "$plan" >/dev/null 2>&1; then
  echo "check-plan-clips-unchanged: ${plan} is not a Terraform plan in JSON." >&2
  exit 2
fi

# One line per finding: "clips\t<address>\t<what>" (a change to Clip Factory) or "guard\t<address>\t<what>" (a Lamo
# Stories route on a path that is not its own). Then "tag\t<true|false>", "api\t<actions>", "live\t<sha or empty>" and
# one "deleted\t<address>\t<what>" per delete or replace.
out="$(jq -r '
  def acts: (.change.actions // []);
  def quiet: acts == ["no-op"] or acts == ["read"];
  def created: acts == ["create"];
  def what: acts | if . == ["update"] then "update in place"
    elif . == ["delete"] then "delete"
    elif (index("delete") != null and index("create") != null) then "replace"
    else join("+") end;

  # The only paths a Lamo Stories route may take (docs/CONTRACTS.md §45.15).
  def stories_route_ok: test("^(ANY|OPTIONS) /v1/workspaces(/\\{proxy\\+\\})?$") or . == "GET /v1/stories-oauth/{platform}/callback";

  # A function: what may differ on every deploy (the shared zip, the release sha) plus the given environment keys.
  def allowed_fn: ["source_code_hash", "last_modified", "version", "qualified_arn", "qualified_invoke_arn"];
  def strip_fn($envkeys):
    (. // {}) | reduce allowed_fn[] as $k (.; del(.[$k]))
    | if (.environment | type) == "array"
      then .environment |= map(if (.variables | type) == "object" then .variables |= (reduce $envkeys[] as $e (.; del(.[$e]))) else . end)
      else . end;
  def env_of($envkeys):
    ((.environment // []) | if type == "array" then (first // {}) else {} end | .variables // {})
    | if type == "object" then (reduce $envkeys[] as $e (.; del(.[$e]))) else {} end;
  def fn_findings($envkeys):
    (.change.before | strip_fn($envkeys)) as $b | (.change.after | strip_fn($envkeys)) as $a
    | ([($b | keys[]), ($a | keys[])] | unique) as $ks
    | [$ks[] | select(. != "environment") | select($b[.] != $a[.])] as $attrs
    | (.change.before | env_of($envkeys)) as $eb | (.change.after | env_of($envkeys)) as $ea
    | [([($eb | keys[]), ($ea | keys[])] | unique)[] | select($eb[.] != $ea[.])] as $envkeys_changed
    | ([.change.after_unknown // {} | paths(. == true) | map(tostring)]
       | map(select((.[0] as $p | allowed_fn | index($p)) == null))
       | map(select((.[0] == "environment" and .[2] == "variables" and (.[3] as $k | $envkeys | index($k)) != null) | not))
       | map(join("."))) as $unknown
    | (($attrs + $unknown) | unique) as $all
    | (if ($all | length) > 0 then ["its " + ($all | join(", "))] else [] end)
      + (if ($envkeys_changed | length) > 0 then ["its environment key(s) " + ($envkeys_changed | join(", "))]
         elif ($b.environment != $a.environment) then ["its environment block"] else [] end);

  # The stage: only the route settings of Lamo Stories routes may change (deployment_id follows auto_deploy).
  def strip_stage:
    (. // {}) | del(.deployment_id)
    | if (.route_settings | type) == "array"
      then .route_settings |= map(select(((.route_key // "") | stories_route_ok) | not)) else . end;
  # A new route_settings entry has logging_level unknown until applied (Optional and Computed): fine on a Lamo Stories route.
  def stage_findings:
    (.change.after // {}) as $raw
    | (.change.before | strip_stage) as $b | (.change.after | strip_stage) as $a
    | ([($b | keys[]), ($a | keys[])] | unique) as $ks
    | [$ks[] | select($b[.] != $a[.])] as $attrs
    | ([.change.after_unknown // {} | paths(. == true)]
       | map(select(.[0] != "deployment_id"))
       | map(select((.[0] == "route_settings" and (.[1] | type) == "number"
           and ((($raw.route_settings // [])[.[1]].route_key // "") | stories_route_ok)) | not))
       | map(.[0] | tostring) | unique) as $unknown
    | (($attrs + $unknown) | unique);

  # Shared pieces that a Lamo Stories deploy leaves exactly as they are.
  def shared_fixed: [
    "module.api.aws_iam_role.fn[\"api\"]", "module.api.aws_iam_role_policy.fn[\"api\"]",
    "module.api.aws_apigatewayv2_api.http", "module.api.aws_apigatewayv2_authorizer.jwt",
    "module.api.aws_lambda_permission.http",
    "module.hooks.aws_iam_role.fn", "module.hooks.aws_iam_role_policy.fn"
  ];
  def piece: if startswith("module.api.aws_iam_") then "cf-prod-api'"'"'s role or policy"
    elif startswith("module.hooks.aws_iam_") then "cf-prod-hooks'"'"' role or policy"
    elif . == "module.api.aws_apigatewayv2_api.http" then "the HTTP API'"'"'s own settings (CORS and the rest, for every Clip Factory call)"
    elif . == "module.api.aws_apigatewayv2_authorizer.jwt" then "the sign-in check of every Clip Factory route"
    else "API Gateway'"'"'s permission to call cf-prod-api" end;

  [(.resource_changes // [])[] | select(.mode == "managed")] as $rc
  | ([$rc[] | select(.address == "module.agent.terraform_data.image") | select(acts | index("create") != null)] | length > 0) as $tag
  | ((
      ($rc[] | select(.address | startswith("module.agent.")) | select(($tag | not) and (quiet | not))
        | ["clips", .address, "Clip Factory'"'"'s agent would \(what), but its image tag did not change"]),
      ($rc[] | select(.address as $a | shared_fixed | index($a)) | select((quiet or created) | not)
        | ["clips", .address, "\(.address | piece) would \(what)"]),
      ($rc[] | select(.address == "module.api.aws_lambda_function.fn[\"api\"]") | select((quiet or created) | not)
        | if acts != ["update"] then ["clips", .address, "cf-prod-api would \(what)"]
          else (fn_findings(["VERSION"])) as $f | select(($f | length) > 0) | ["clips", .address, "cf-prod-api would change " + ($f | join(" and "))] end),
      ($rc[] | select(.address == "module.hooks.aws_lambda_function.fn") | select((quiet or created) | not)
        | if acts != ["update"] then ["clips", .address, "cf-prod-hooks would \(what)"]
          else (fn_findings(["STORIES_OAUTH_CALLBACK"])) as $f | select(($f | length) > 0) | ["clips", .address, "cf-prod-hooks would change " + ($f | join(" and "))] end),
      ($rc[] | select(.address == "module.api.aws_apigatewayv2_stage.http") | select((quiet or created) | not)
        | if acts != ["update"] then ["clips", .address, "the HTTP API'"'"'s stage would \(what)"]
          else stage_findings as $f | select(($f | length) > 0)
            | ["clips", .address, "the HTTP API'"'"'s stage would change its " + ($f | join(", ")) + " (only Funded Clips'"'"' own route settings may change)"] end),
      ($rc[] | select(.address | test("^module\\.api\\.aws_apigatewayv2_(route|integration)\\."))
        | select(.address | test("^module\\.api\\.aws_apigatewayv2_(route|integration)\\.stories\\[") | not)
        | select((quiet or created) | not)
        | ["clips", .address, "an HTTP API route or integration would \(what)"]),
      ($rc[] | select(.address | startswith("module.api.aws_apigatewayv2_route.stories["))
        | select((quiet or (acts == ["delete"])) | not)
        | select((.change.after.route_key // "") | stories_route_ok | not)
        | ["guard", .address, "a Funded Clips route would take a path that is not its own (\(.change.after.route_key // "unknown"))"])
    ) | @tsv),
    "tag\t\($tag)",
    "api\t\([$rc[] | select(.address == "module.api.aws_lambda_function.fn[\"api\"]") | acts | join("+")] | first // "none")",
    "live\t\([$rc[] | select(.address == "module.api.aws_lambda_function.fn[\"api\"]")
      | .change.before.environment // [] | if type == "array" then (first // {}) else {} end | .variables.VERSION // empty] | first // "")",
    ($rc[] | select(acts | index("delete") != null) | "deleted\t\(.address)\t\(what)")
' "$plan")"

clips="$(awk -F'\t' '$1 == "clips" { print $2 "\t" $3 }' <<<"$out")"
guard="$(awk -F'\t' '$1 == "guard" { print $2 "\t" $3 }' <<<"$out")"
tag_changed="$(awk -F'\t' '$1 == "tag" { print $2 }' <<<"$out")"
api_actions="$(awk -F'\t' '$1 == "api" { print $2 }' <<<"$out")"
live="$(awk -F'\t' '$1 == "live" { print $2 }' <<<"$out")"

summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >>"$GITHUB_STEP_SUMMARY"; fi; }

# §45.18: what the plan deletes or replaces is read after every deploy (it must be an image build trigger, such as
# module.stories_agent.terraform_data.image). Listed here for that reading; the delete gate decides what holds data.
deleted="$(awk -F'\t' '$1 == "deleted" { print "  - " $2 " (" $3 ")" }' <<<"$out")"
if [ -n "$deleted" ]; then
  echo "Replaced or deleted in this plan:"
  echo "$deleted"
else
  echo "Replaced or deleted in this plan: nothing."
fi

# ---------- Whose work is in this deploy (the commits since the live release) ----------
stories_paths='^(stories/|web/src/stories/|web/test/stories|web/e2e/stories|infra/modules/stories_|api/src/clipfactory_api/workspaces/|api/src/clipfactory_api/flows/story_flow\.py$|api/tests/ws_|api/tests/workspaces/)'
# The app's name in a commit message, any case, as whole words (so "unfunded clips" is not it): today's "Funded
# Clips" and its three old names (§45.18).
stories_names='lamo stories|clip factory stories|clip stories|funded clips'
plan_paths='^(infra/|\.github/workflows/deploy\.yml$|agent/|skills/|config/)'
agent_paths='^(agent/|skills/|config/)'
empty_tree="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
git_dir="${CLIPS_CHECK_GIT_DIR:-.}"
g() { git -C "$git_dir" "$@"; }

scope="unknown" # clips: no Funded Clips commit feeds this plan; stories: at least one does; unknown: history unreadable
why_unknown=""
stories_commits=()
agent_commits=()
if ! [[ "$live" =~ ^[0-9a-f]{7,40}$ ]]; then
  why_unknown="the plan has no live release (cf-prod-api's VERSION) to compare with"
elif ! g rev-parse -q --verify "${live}^{commit}" >/dev/null 2>&1 || ! g rev-parse -q --verify "HEAD^{commit}" >/dev/null 2>&1; then
  why_unknown="the live release ${live:0:7} is not in this checkout's history"
elif ! commits="$(g rev-list --first-parent "${live}..HEAD" 2>/dev/null)"; then
  why_unknown="the commits since the live release ${live:0:7} could not be listed"
else
  scope="clips"
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    parent="$(g rev-parse -q --verify "${c}^1" 2>/dev/null || echo "$empty_tree")"
    files="$(g diff --name-only "$parent" "$c")"
    subject="$(g log -1 --format='%h %s' "$c")"
    message="$(g log -1 --format=%B "$c")"
    if grep -Eq "$stories_paths" <<<"$files" || grep -qiE "(^|[^a-z])(${stories_names})([^a-z]|$)" <<<"$message"; then
      if grep -Eq "$plan_paths" <<<"$files"; then
        scope="stories"
        stories_commits+=("$subject")
      fi
      if grep -Eq "$agent_paths" <<<"$files"; then
        agent_commits+=("$subject")
      fi
    fi
  done <<<"$commits"
fi

for subject in ${agent_commits[@]+"${agent_commits[@]}"}; do
  clips+="${clips:+$'\n'}commit ${subject%% *}"$'\t'"this Funded Clips commit changes Clip Factory's agent sources (agent/, skills/ or config/), which Funded Clips never touches"
done

case "$scope" in
  clips) echo "Whose change: no commit since the live release ${live:0:7} is Funded Clips work that feeds this plan." ;;
  stories)
    echo "Whose change: Funded Clips work since the live release ${live:0:7} feeds this plan:"
    printf '  - %s\n' ${stories_commits[@]+"${stories_commits[@]}"}
    ;;
  *) echo "Whose change: unknown (${why_unknown}), so any change to Clip Factory stops the deploy." ;;
esac

# ---------- The route rule: always stops the deploy ----------
if [ -n "$guard" ]; then
  echo "Clip Factory check: this deploy is stopped. A Funded Clips route would take a path of Clip Factory's:" >&2
  while IFS=$'\t' read -r address why; do
    echo "  - ${address}: ${why}." >&2
    summary "- \`${address}\`: ${why}."
  done <<<"$guard"
  echo "Nothing was changed. Funded Clips' routes are only /v1/workspaces, /v1/workspaces/{proxy+} and its OAuth" >&2
  echo "callback; fix infra/modules/api and push again. \"Clip Factory changes on purpose\" does not let this through." >&2
  exit 1
fi

if [ -z "$clips" ]; then
  echo "Clip Factory check: the plan changes nothing of Clip Factory's agent, cf-prod-api (function, role, environment),"
  echo "  cf-prod-hooks (function, role, environment) or the HTTP API (its settings, sign-in check, stage and routes)."
  if [ "$api_actions" = "update" ]; then
    echo "  cf-prod-api gets this release's package and VERSION, as on every deploy."
  fi
  if [ "$tag_changed" = "true" ]; then
    echo "  Clip Factory's agent image tag changed in this deploy (a Clip Factory change), so its agent may update."
  fi
  summary "Clip Factory check: unchanged by this plan."
  exit 0
fi

if [ "$scope" = "clips" ]; then
  echo "Clip Factory check: these changes to Clip Factory come from Clip Factory's own commits (no Funded Clips work"
  echo "  since the live release ${live:0:7} feeds this plan), so the deploy goes on:"
  while IFS=$'\t' read -r address why; do
    echo "::notice title=Clip Factory's own change::${address}: ${why}."
  done <<<"$clips"
  summary "Clip Factory check: Clip Factory's own changes only (no Funded Clips work in this deploy changes it)."
  exit 0
fi

if [ "${ALLOW_CLIPS_CHANGE:-}" = "true" ]; then
  echo "Clip Factory check: this deploy changes Clip Factory on purpose (run with \"Clip Factory changes on purpose\"):"
  while IFS=$'\t' read -r address why; do
    echo "::warning title=Clip Factory changes on purpose::${address}: ${why}."
  done <<<"$clips"
  summary "Clip Factory check: Clip Factory changes on purpose in this run (see the warnings)."
  exit 0
fi

echo "Clip Factory check: this deploy is stopped. Funded Clips work is in it, and the plan would change Clip Factory," >&2
echo "which Funded Clips must never do:" >&2
while IFS=$'\t' read -r address why; do
  echo "  - ${address}: ${why}." >&2
  summary "- \`${address}\`: ${why}."
done <<<"$clips"
echo "Nothing was changed. If a Funded Clips change caused this, keep it inside Funded Clips' own modules and push" >&2
echo "again. If the change comes from a Clip Factory pull request deployed together with Funded Clips work, check" >&2
echo "that, then run the deploy again from Actions › deploy › Run workflow with \"Clip Factory changes on purpose\" ticked." >&2
exit 1

#!/usr/bin/env bash
# Clip Factory unchanged (docs/CONTRACTS.md §45.1, §45.15, §45.18; the owner's rule for Lamo Stories: "Clip Factory must
# stay exactly as it is"). Runs in deploy.yml after the delete gate, on the same saved plan, before anything is
# applied. Reads a Terraform plan as JSON (terraform show -json prod.tfplan) and fails when the plan would change:
#   - anything under module.agent. (Clip Factory's agent: its image, runtime, role, repository), created, changed or
#     deleted, unless Clip Factory's own agent image tag changed in this deploy (module.agent.terraform_data.image is
#     replaced, or created on a deploy from nothing: a Clip Factory change);
#   - cf-prod-api's role or its policy;
#   - cf-prod-api's function in anything but source_code_hash, last_modified, version, qualified_arn,
#     qualified_invoke_arn and environment.variables.VERSION (this release's shared zip and git sha, as on every deploy);
#     never its handler, runtime, memory, timeout, role or any other environment key;
#   - an existing route or integration of the HTTP API (new ones may be added);
#   - and a Lamo Stories route (module.api.aws_apigatewayv2_route.stories[...]) may only be one of its own paths, so it
#     can never take over a Clip Factory path.
# It prints addresses, attribute names and environment key names only, never a value.
#
# Usage: bash scripts/check-plan-clips-unchanged.sh plan.json
# Exit 0: Clip Factory does not change. Exit 1: it would (each finding is named, in plain words). Exit 2: the plan file
# is missing or is not a Terraform plan.
# ALLOW_CLIPS_CHANGE=true: this deploy changes Clip Factory on purpose (a Clip Factory pull request; deploy.yml passes
# the "Clip Factory changes on purpose" input of a manual run). The findings are printed as warnings and it exits 0.
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

# One line per finding: "<address>\t<what would change>". Then one line "tag\t<true|false>" and "api\t<actions>".
out="$(jq -r '
  def acts: (.change.actions // []);
  def quiet: acts == ["no-op"] or acts == ["read"];
  def created: acts == ["create"];
  def what: acts | if . == ["update"] then "update in place"
    elif . == ["delete"] then "delete"
    elif (index("delete") != null and index("create") != null) then "replace"
    else join("+") end;

  # cf-prod-api: what may differ on every deploy (the shared zip and the release sha).
  def allowed_fn: ["source_code_hash", "last_modified", "version", "qualified_arn", "qualified_invoke_arn"];
  def strip_fn:
    (. // {}) | reduce allowed_fn[] as $k (.; del(.[$k]))
    | if (.environment | type) == "array"
      then .environment |= map(if (.variables | type) == "object" then .variables |= del(.VERSION) else . end)
      else . end;
  def env_of: ((.environment // []) | if type == "array" then (first // {}) else {} end | .variables // {}) | del(.VERSION);
  def fn_findings:
    (.change.before | strip_fn) as $b | (.change.after | strip_fn) as $a
    | ([($b | keys[]), ($a | keys[])] | unique) as $ks
    | [$ks[] | select(. != "environment") | select($b[.] != $a[.])] as $attrs
    | (.change.before | env_of) as $eb | (.change.after | env_of) as $ea
    | [([($eb | keys[]), ($ea | keys[])] | unique)[] | select($eb[.] != $ea[.])] as $envkeys
    | ([.change.after_unknown // {} | paths(. == true) | map(tostring) | join(".")]
       | map(select(. as $p | (allowed_fn | index($p)) == null))) as $unknown
    | (($attrs + $unknown) | unique) as $all
    | (if ($all | length) > 0 then ["its " + ($all | join(", "))] else [] end)
      + (if ($envkeys | length) > 0 then ["its environment key(s) " + ($envkeys | join(", "))]
         elif ($b.environment != $a.environment) then ["its environment block"] else [] end);

  # The only paths a Lamo Stories route may take (docs/CONTRACTS.md §45.15).
  def stories_route_ok: test("^(ANY|OPTIONS) /v1/workspaces(/\\{proxy\\+\\})?$") or . == "GET /v1/stories-oauth/{platform}/callback";

  [(.resource_changes // [])[] | select(.mode == "managed")] as $rc
  | ([$rc[] | select(.address == "module.agent.terraform_data.image") | select(acts | index("create") != null)] | length > 0) as $tag
  | ((
      ($rc[] | select(.address | startswith("module.agent.")) | select(($tag | not) and (quiet | not))
        | [.address, "Clip Factory'"'"'s agent would \(what), but its image tag did not change"]),
      ($rc[] | select(.address == "module.api.aws_iam_role.fn[\"api\"]" or .address == "module.api.aws_iam_role_policy.fn[\"api\"]")
        | select((quiet or created) | not)
        | [.address, "cf-prod-api'"'"'s role or policy would \(what)"]),
      ($rc[] | select(.address == "module.api.aws_lambda_function.fn[\"api\"]") | select((quiet or created) | not)
        | if acts != ["update"] then [.address, "cf-prod-api would \(what)"]
          else (fn_findings) as $f | select(($f | length) > 0) | [.address, "cf-prod-api would change " + ($f | join(" and "))] end),
      ($rc[] | select(.address | test("^module\\.api\\.aws_apigatewayv2_(route|integration)\\."))
        | select((quiet or created) | not)
        | [.address, "an HTTP API route or integration would \(what)"]),
      ($rc[] | select(.address | startswith("module.api.aws_apigatewayv2_route.stories["))
        | select((quiet or (acts == ["delete"])) | not)
        | select((.change.after.route_key // "") | stories_route_ok | not)
        | [.address, "a Lamo Stories route would take a path that is not its own (\(.change.after.route_key // "unknown"))"])
    ) | @tsv),
    "tag\t\($tag)",
    "api\t\([$rc[] | select(.address == "module.api.aws_lambda_function.fn[\"api\"]") | acts | join("+")] | first // "none")",
    ($rc[] | select(acts | index("delete") != null) | "deleted\t\(.address)\t\(what)")
' "$plan")"

findings="$(grep -vE $'^(tag|api|deleted)\t' <<<"$out" || true)"
tag_changed="$(awk -F'\t' '$1 == "tag" { print $2 }' <<<"$out")"
api_actions="$(awk -F'\t' '$1 == "api" { print $2 }' <<<"$out")"

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

if [ -z "$findings" ]; then
  echo "Clip Factory check: the plan changes nothing of Clip Factory's agent, cf-prod-api (function, role, environment) or the HTTP API's existing routes."
  if [ "$api_actions" = "update" ]; then
    echo "  cf-prod-api gets this release's package and VERSION, as on every deploy."
  fi
  if [ "$tag_changed" = "true" ]; then
    echo "  Clip Factory's agent image tag changed in this deploy (a Clip Factory change), so its agent may update."
  fi
  summary "Clip Factory check: unchanged by this plan."
  exit 0
fi

if [ "${ALLOW_CLIPS_CHANGE:-}" = "true" ]; then
  echo "Clip Factory check: this deploy changes Clip Factory on purpose (run with \"Clip Factory changes on purpose\"):"
  while IFS=$'\t' read -r address why; do
    echo "::warning title=Clip Factory changes on purpose::${address}: ${why}."
  done <<<"$findings"
  summary "Clip Factory check: Clip Factory changes on purpose in this run (see the warnings)."
  exit 0
fi

echo "Clip Factory check: this deploy is stopped. The plan would change Clip Factory, which Lamo Stories must never do:" >&2
while IFS=$'\t' read -r address why; do
  echo "  - ${address}: ${why}." >&2
  summary "- \`${address}\`: ${why}."
done <<<"$findings"
echo "Nothing was changed. If a Lamo Stories change caused this, keep it inside Lamo Stories' own modules and push" >&2
echo "again. If a Clip Factory pull request changes this on purpose, run the deploy again from Actions › deploy ›" >&2
echo "Run workflow with \"Clip Factory changes on purpose\" ticked." >&2
exit 1

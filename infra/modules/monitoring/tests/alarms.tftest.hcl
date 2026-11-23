# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/monitoring && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §14.9: errors for every watched function, failed and timed-out durable executions for both flows,
# the broadcaster's iterator age and the webhook API's 5xx answers. The dead-letter queue alarm is gone with the queue.

mock_provider "aws" {}

variables {
  name       = "cf-test"
  account_id = "123456789012"
  function_names = {
    api       = "cf-test-api"
    job-flow  = "cf-test-job-flow"
    clip-flow = "cf-test-clip-flow"
    ws        = "cf-test-ws"
    broadcast = "cf-test-broadcast"
    hooks     = "cf-test-hooks"
    stats     = "cf-test-stats"
    learn     = "cf-test-learn"
  }
  schedule_rule_names = {
    stats = "cf-test-stats"
  }
  durable_function_names = {
    job-flow  = "cf-test-job-flow"
    clip-flow = "cf-test-clip-flow"
  }
  stream_consumer_name = "cf-test-broadcast"
  hooks_api_name       = "cf-test-hooks"
}

run "alarms_match_the_contract" {
  command = plan

  assert {
    condition = toset([for a in aws_cloudwatch_metric_alarm.lambda_errors : a.alarm_name]) == toset([
      "cf-test-api-errors", "cf-test-job-flow-errors", "cf-test-clip-flow-errors", "cf-test-ws-errors",
      "cf-test-broadcast-errors", "cf-test-hooks-errors", "cf-test-stats-errors", "cf-test-learn-errors",
    ])
    error_message = "Every watched function gets an <fn>-errors alarm."
  }

  assert {
    condition = toset([for a in aws_cloudwatch_metric_alarm.durable : a.alarm_name]) == toset([
      "cf-test-job-flow-durable-failed", "cf-test-job-flow-durable-timed-out",
      "cf-test-clip-flow-durable-failed", "cf-test-clip-flow-durable-timed-out",
    ])
    error_message = "Both flows get <fn>-durable-failed and <fn>-durable-timed-out."
  }

  assert {
    condition = alltrue([
      for a in aws_cloudwatch_metric_alarm.durable :
      a.namespace == "AWS/Lambda" && contains(["DurableExecutionFailed", "DurableExecutionTimedOut"], a.metric_name) &&
      a.statistic == "Sum" && a.period == 300 && a.threshold == 0 && a.treat_missing_data == "notBreaching" &&
      a.metric_name == (endswith(a.alarm_name, "-durable-failed") ? "DurableExecutionFailed" : "DurableExecutionTimedOut")
    ])
    error_message = "Durable alarms: AWS/Lambda DurableExecutionFailed / DurableExecutionTimedOut, Sum over 5 min > 0, notBreaching."
  }

  assert {
    condition = (aws_cloudwatch_metric_alarm.stream_iterator_age.alarm_name == "cf-test-broadcast-iterator-age" &&
      aws_cloudwatch_metric_alarm.stream_iterator_age.metric_name == "IteratorAge" &&
      aws_cloudwatch_metric_alarm.stream_iterator_age.statistic == "Maximum" &&
      aws_cloudwatch_metric_alarm.stream_iterator_age.threshold == 300000 &&
    aws_cloudwatch_metric_alarm.stream_iterator_age.evaluation_periods == 3)
    error_message = "Iterator age: Maximum > 300 000 ms for 3 x 5 minutes."
  }

  assert {
    condition = (aws_cloudwatch_metric_alarm.hooks_5xx.alarm_name == "cf-test-hooks-5xx" &&
      aws_cloudwatch_metric_alarm.hooks_5xx.namespace == "AWS/ApiGateway" &&
      aws_cloudwatch_metric_alarm.hooks_5xx.metric_name == "5XXError" &&
    aws_cloudwatch_metric_alarm.hooks_5xx.dimensions == tomap({ ApiName = "cf-test-hooks", Stage = "v1" }))
    error_message = "The webhook API alarm watches 5XXError on ApiName cf-prod-hooks, stage v1."
  }
}

# docs/CONTRACTS.md §16.9: the stats tick is watched for failed invocations (numbers would silently stop refreshing).
run "stats_schedule_is_watched" {
  command = plan

  assert {
    condition = (aws_cloudwatch_metric_alarm.schedule_failed["stats"].alarm_name == "cf-test-stats-failed-invocations" &&
      aws_cloudwatch_metric_alarm.schedule_failed["stats"].namespace == "AWS/Events" &&
      aws_cloudwatch_metric_alarm.schedule_failed["stats"].metric_name == "FailedInvocations" &&
      aws_cloudwatch_metric_alarm.schedule_failed["stats"].dimensions == tomap({ RuleName = "cf-test-stats" }) &&
      aws_cloudwatch_metric_alarm.schedule_failed["stats"].threshold == 0 &&
    aws_cloudwatch_metric_alarm.schedule_failed["stats"].treat_missing_data == "notBreaching")
    error_message = "The stats rule needs a FailedInvocations > 0 alarm on its RuleName."
  }

  assert {
    condition     = output.alarm_names["stats"] == "cf-test-stats-errors" && output.alarm_names["learn"] == "cf-test-learn-errors"
    error_message = "cf-prod-stats and cf-prod-learn get <fn>-errors alarms."
  }
}

run "no_schedules_no_schedule_alarms" {
  command = plan

  variables {
    schedule_rule_names = {}
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.schedule_failed) == 0
    error_message = "Without schedule rules there are no FailedInvocations alarms."
  }
}

# docs/CONTRACTS.md §19.9: Ask Clip Factory's model errors and timeouts (each fell back to a plain answer) are
# counted from the help.answer log line and alarm at 10 in an hour.
run "help_model_failures_are_watched" {
  command = plan

  variables {
    help_log_group_name = "/aws/lambda/cf-test-api"
  }

  assert {
    condition = (aws_cloudwatch_log_metric_filter.help_model_failures[0].log_group_name == "/aws/lambda/cf-test-api" &&
      strcontains(aws_cloudwatch_log_metric_filter.help_model_failures[0].pattern, "$.event = \"help.answer\"") &&
      strcontains(aws_cloudwatch_log_metric_filter.help_model_failures[0].pattern, "$.outcome = \"kb_model_error\"") &&
      strcontains(aws_cloudwatch_log_metric_filter.help_model_failures[0].pattern, "$.outcome = \"kb_model_timeout\"") &&
      aws_cloudwatch_log_metric_filter.help_model_failures[0].metric_transformation[0].namespace == "cf-test" &&
    aws_cloudwatch_log_metric_filter.help_model_failures[0].metric_transformation[0].name == "HelpModelFailures")
    error_message = "The metric filter counts help.answer lines with outcome kb_model_error or kb_model_timeout as <name>/HelpModelFailures."
  }

  assert {
    condition = (aws_cloudwatch_metric_alarm.help_model_failures[0].alarm_name == "cf-test-help-model-failures" &&
      aws_cloudwatch_metric_alarm.help_model_failures[0].namespace == "cf-test" &&
      aws_cloudwatch_metric_alarm.help_model_failures[0].metric_name == "HelpModelFailures" &&
      aws_cloudwatch_metric_alarm.help_model_failures[0].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.help_model_failures[0].period == 3600 &&
      aws_cloudwatch_metric_alarm.help_model_failures[0].threshold == 10 &&
      aws_cloudwatch_metric_alarm.help_model_failures[0].comparison_operator == "GreaterThanOrEqualToThreshold" &&
    aws_cloudwatch_metric_alarm.help_model_failures[0].treat_missing_data == "notBreaching")
    error_message = "Alarm <name>-help-model-failures: Sum of HelpModelFailures >= 10 in one hour, notBreaching."
  }

  assert {
    condition     = output.help_alarm_name == "cf-test-help-model-failures"
    error_message = "help_alarm_name names the help model alarm."
  }
}

run "no_help_log_group_no_help_alarm" {
  command = plan

  assert {
    condition     = length(aws_cloudwatch_log_metric_filter.help_model_failures) == 0 && length(aws_cloudwatch_metric_alarm.help_model_failures) == 0 && output.help_alarm_name == null
    error_message = "Without the API log group there is no help metric filter or alarm."
  }
}

# docs/CONTRACTS.md §28.10, §28.11: Ask's model failures and its daily input tokens.
run "ask_is_watched" {
  command = plan
  variables {
    ask_log_group_name = "/aws/lambda/cf-test-ask"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.ask_model_failures[0].alarm_name == "cf-test-ask-model-failures" && aws_cloudwatch_metric_alarm.ask_model_failures[0].threshold == 10 && aws_cloudwatch_metric_alarm.ask_model_failures[0].period == 3600
    error_message = "cf-prod-ask-model-failures fires at 10 or more in an hour."
  }

  assert {
    condition     = strcontains(aws_cloudwatch_log_metric_filter.ask_model_failures[0].pattern, "ask_model_error") && strcontains(aws_cloudwatch_log_metric_filter.ask_model_failures[0].pattern, "ask_model_timeout")
    error_message = "The filter counts help.ask lines with ask_model_error or ask_model_timeout."
  }

  assert {
    condition     = toset(keys(aws_cloudwatch_log_metric_filter.ask_tokens)) == toset(["AskInputTokens", "AskOutputTokens"]) && one(aws_cloudwatch_log_metric_filter.ask_tokens["AskInputTokens"].metric_transformation).value == "$.usageIn"
    error_message = "AskInputTokens and AskOutputTokens sum usageIn and usageOut."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.ask_tokens_day[0].alarm_name == "cf-test-ask-tokens-day" && aws_cloudwatch_metric_alarm.ask_tokens_day[0].threshold == 20000000 && aws_cloudwatch_metric_alarm.ask_tokens_day[0].period == 86400
    error_message = "cf-prod-ask-tokens-day: over 20M input tokens in 24 h."
  }
}

run "no_ask_log_group_no_ask_alarms" {
  command = plan

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ask_model_failures) == 0 && length(aws_cloudwatch_log_metric_filter.ask_tokens) == 0
    error_message = "Without cf-prod-ask's log group there are no Ask alarms."
  }
}

# docs/CONTRACTS.md §45.15: Lamo Stories' API Lambda is watched like every function (an <fn>-errors alarm from
# function_names) and its agent runtime for error lines; off by default, so Clip Factory's alarms stay as they are.
run "lamo_stories_is_watched" {
  command = plan

  variables {
    function_names = {
      api         = "cf-test-api"
      stories-api = "cf-test-stories-api"
    }
    stories_agent_alarm_enabled  = true
    stories_agent_log_group_name = "/aws/bedrock-agentcore/runtimes/cf_test_story_agent-AbCdEf1234-DEFAULT"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.lambda_errors["stories-api"].alarm_name == "cf-test-stories-api-errors" && aws_cloudwatch_metric_alarm.lambda_errors["api"].alarm_name == "cf-test-api-errors"
    error_message = "cf-prod-stories-api gets its own errors alarm next to cf-prod-api's."
  }

  assert {
    condition = (aws_cloudwatch_log_metric_filter.stories_agent_errors[0].log_group_name == "/aws/bedrock-agentcore/runtimes/cf_test_story_agent-AbCdEf1234-DEFAULT" &&
      aws_cloudwatch_log_metric_filter.stories_agent_errors[0].pattern == "{ $.level = \"error\" }" &&
      one(aws_cloudwatch_log_metric_filter.stories_agent_errors[0].metric_transformation).name == "StoriesAgentErrors" &&
    one(aws_cloudwatch_log_metric_filter.stories_agent_errors[0].metric_transformation).namespace == "cf-test")
    error_message = "The story runtime's error lines are counted from its own log group."
  }

  assert {
    condition = (aws_cloudwatch_metric_alarm.stories_agent_errors[0].alarm_name == "cf-test-stories-agent-errors" &&
      aws_cloudwatch_metric_alarm.stories_agent_errors[0].metric_name == "StoriesAgentErrors" &&
      aws_cloudwatch_metric_alarm.stories_agent_errors[0].period == 3600 && aws_cloudwatch_metric_alarm.stories_agent_errors[0].threshold == 5 &&
      aws_cloudwatch_metric_alarm.stories_agent_errors[0].comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.stories_agent_errors[0].treat_missing_data == "notBreaching" &&
    output.stories_agent_alarm_name == "cf-test-stories-agent-errors")
    error_message = "Five error lines of the story runtime in an hour email the owner."
  }
}

run "lamo_stories_agent_alarm_off_by_default" {
  command = plan

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.stories_agent_errors) == 0 && length(aws_cloudwatch_log_metric_filter.stories_agent_errors) == 0 && output.stories_agent_alarm_name == null
    error_message = "Without the switch, no Funded Clips alarm is added."
  }
}

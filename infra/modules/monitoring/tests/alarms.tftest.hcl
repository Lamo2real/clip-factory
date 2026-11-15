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
      "cf-test-broadcast-errors", "cf-test-hooks-errors",
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

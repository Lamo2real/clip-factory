# Alarms that email the owner when a Lambda fails, a durable execution fails or times out, the live-update stream
# falls behind, the webhook API answers 5xx (docs/CONTRACTS.md §14.9), or a schedule cannot start its function
# (the stats refresh tick, §16.9). The topic always exists, so an email
# address can be added later without touching the alarms.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags = { Component = "monitoring" }

  durable_metrics = {
    durable-failed = {
      metric      = "DurableExecutionFailed"
      description = "failed with an error the flow did not expect (a bug: expected outcomes never fail the execution)"
    }
    durable-timed-out = {
      metric      = "DurableExecutionTimedOut"
      description = "ran past its execution timeout"
    }
  }

  # One alarm per durable function and metric, keyed "<fn key>/<suffix>".
  durable_alarms = merge([
    for fk, fn in var.durable_function_names : {
      for mk, m in local.durable_metrics : "${fk}/${mk}" => merge(m, { function = fn, suffix = mk })
    }
  ]...)
}

# Not encrypted with the AWS managed SNS key on purpose: its key policy does not let CloudWatch alarms publish.
# Alarm messages carry only alarm names and states.
resource "aws_sns_topic" "alarms" {
  name = "${var.name}-alarms"
  tags = local.tags
}

resource "aws_sns_topic_policy" "alarms" {
  arn = aws_sns_topic.alarms.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudWatchAlarmsOfThisAccount"
      Effect    = "Allow"
      Principal = { Service = "cloudwatch.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.alarms.arn
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
    }]
  })
}

# The owner confirms the subscription from the email AWS sends.
resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = var.function_names
  alarm_name          = "${each.value}-errors"
  alarm_description   = "The ${each.key} function failed in the last 5 minutes. Its log group /aws/lambda/${each.value} says why."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "durable" {
  for_each            = local.durable_alarms
  alarm_name          = "${each.value.function}-${each.value.suffix}"
  alarm_description   = "A durable execution of ${each.value.function} ${each.value.description}. List its executions in the Lambda console (Durable executions tab) and read /aws/lambda/${each.value.function}."
  namespace           = "AWS/Lambda"
  metric_name         = each.value.metric
  dimensions          = { FunctionName = each.value.function }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = local.tags
}

# Live updates lag when the broadcaster falls more than 5 minutes behind the table's stream for 15 minutes.
resource "aws_cloudwatch_metric_alarm" "stream_iterator_age" {
  alarm_name          = "${var.stream_consumer_name}-iterator-age"
  alarm_description   = "${var.stream_consumer_name} is more than 5 minutes behind the DynamoDB stream, so live updates are late. Read /aws/lambda/${var.stream_consumer_name}."
  namespace           = "AWS/Lambda"
  metric_name         = "IteratorAge"
  dimensions          = { FunctionName = var.stream_consumer_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 300000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "hooks_5xx" {
  alarm_name          = "${var.hooks_api_name}-5xx"
  alarm_description   = "The webhook API ${var.hooks_api_name} answered with a server error. Read /aws/apigateway/${var.hooks_api_name} and /aws/lambda/${var.hooks_api_name}."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5XXError"
  dimensions          = { ApiName = var.hooks_api_name, Stage = var.hooks_stage_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = local.tags
}

# A scheduled rule could not invoke its function (permission removed, function deleted or throttled past the event's
# age), so clip numbers stop refreshing. Two misses in a row: one late tick is covered by the next.
resource "aws_cloudwatch_metric_alarm" "schedule_failed" {
  for_each            = var.schedule_rule_names
  alarm_name          = "${each.value}-failed-invocations"
  alarm_description   = "The schedule ${each.value} could not start its function, so the ${each.key} job is not running. Check the rule's target and the function's resource policy."
  namespace           = "AWS/Events"
  metric_name         = "FailedInvocations"
  dimensions          = { RuleName = each.value }
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = local.tags
}

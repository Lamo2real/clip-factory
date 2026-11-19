variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "account_id" { type = string }

variable "alarm_email" {
  type        = string
  default     = ""
  description = "Where alarms are emailed. Empty: alarms still fire and show in CloudWatch, nobody is emailed."
}

variable "function_names" {
  type        = map(string)
  description = "Lambda functions to watch for errors, keyed by role (every module's function_names merged)."
}

variable "durable_function_names" {
  type        = map(string)
  description = "Durable functions whose executions may fail or time out (job-flow, clip-flow)."
}

variable "stream_consumer_name" {
  type        = string
  description = "The DynamoDB stream consumer (cf-prod-broadcast), watched for iterator age."
}

variable "hooks_api_name" {
  type        = string
  description = "Name of the webhook REST API (cf-prod-hooks), watched for 5xx answers."
}

variable "hooks_stage_name" {
  type    = string
  default = "v1"
}

variable "schedule_rule_names" {
  type        = map(string)
  default     = {}
  description = "EventBridge schedule rules watched for failed invocations, keyed by job (stats = cf-prod-stats)."
}

variable "help_log_group_name" {
  type        = string
  default     = ""
  description = "cf-prod-api's log group (/aws/lambda/cf-prod-api), where Ask Clip Factory writes one help.answer line per question (docs/CONTRACTS.md §19.9). Empty: no help model alarm."
}

variable "help_model_failure_threshold" {
  type        = number
  default     = 10
  description = "Help model calls that errored or timed out in one hour before the alarm fires. Each one still gave the owner a plain answer."
}

variable "ask_log_group_name" {
  type        = string
  default     = ""
  description = "cf-prod-ask's log group, where Ask writes one help.ask line per answer (docs/CONTRACTS.md §28.11). Empty: no Ask alarms."
}

variable "ask_tokens_alarm_threshold" {
  type        = number
  default     = 20000000
  description = "New input tokens (usageIn) Ask may read in 24 hours before the alarm tells the owner. It blocks nothing."
}

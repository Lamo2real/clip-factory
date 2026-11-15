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

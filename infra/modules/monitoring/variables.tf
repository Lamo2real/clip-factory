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

variable "dlq_name" {
  type        = string
  description = "The publish queue's dead-letter queue."
}

variable "function_names" {
  type        = map(string)
  description = "Lambda functions to watch for errors, keyed by role."
}

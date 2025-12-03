###########################################
#  TERRAFORM + PROVIDERS
###########################################

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# For ACM (CloudFront certificates must be created in us-east-1)
provider "aws" {
  alias  = "us"
  region = "us-east-1"
}

###########################################
#  VARIABLES
###########################################

variable "aws_region" {
  type    = string
  default = "eu-central-1"
}

variable "project_name" {
  type    = string
  default = "tadone"
}

variable "environment" {
  type    = string
  default = "prod"
}

###########################################
# RANDOM SUFFIX (für Bucket-Namen)
###########################################

resource "random_string" "suffix" {
  length  = 8
  lower   = true
  upper   = false
  numeric = true
  special = false
}

###########################################
#  DYNAMODB TASK TABLE
###########################################

resource "aws_dynamodb_table" "tasks" {
  name         = "${var.project_name}-tasks-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "userId"
  range_key = "taskId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "taskId"
    type = "S"
  }
}

###########################################
#  AUDIO S3 BUCKET
###########################################

resource "aws_s3_bucket" "audio" {
  bucket = "${var.project_name}-audio-${var.environment}-${random_string.suffix.result}"
}

resource "aws_s3_bucket_public_access_block" "audio" {
  bucket = aws_s3_bucket.audio.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "audio" {
  bucket = aws_s3_bucket.audio.id

  versioning_configuration {
    status = "Enabled"
  }
}

###########################################
#  COGNITO
###########################################

resource "aws_cognito_user_pool" "this" {
  name = "${var.project_name}-user-pool-${var.environment}"

  alias_attributes         = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

###########################################
#  COGNITO DOMAIN
###########################################

resource "aws_cognito_user_pool_domain" "this" {
  domain       = "tadone"
  user_pool_id = aws_cognito_user_pool.this.id
}


resource "aws_cognito_user_pool_client" "this" {
  name         = "${var.project_name}-client-${var.environment}"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  # 🔥 WICHTIG: OAuth2 aktivieren
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  # Redirect-URLs
  callback_urls = [
    "https://tadone.leitnersoft.com/",
    "http://localhost:3000/"
  ]

  logout_urls = [
    "https://tadone.leitnersoft.com/",
    "http://localhost:3000/"
  ]

  # Hosted UI identity provider
  supported_identity_providers = ["COGNITO"]

  # auth flows for username/password fallback
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH"
  ]

  # Token Validities
  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

###########################################
#  IAM ROLE FOR LAMBDA
###########################################

resource "aws_iam_role" "lambda_exec" {
  name = "${var.project_name}-lambda-exec-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_transcribe" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonTranscribeFullAccess"
}

resource "aws_iam_role_policy" "lambda_permissions" {
  name = "${var.project_name}-lambda-permissions-${var.environment}"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:*"
        ]
        Resource = aws_dynamodb_table.tasks.arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.audio.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "transcribe:StartTranscriptionJob",
          "transcribe:GetTranscriptionJob"
        ]
        Resource = "*"
      }
    ]
  })
}

###########################################
#  LAMBDA
###########################################

resource "aws_lambda_function" "tasks_api" {
  function_name = "${var.project_name}-tasks-api-${var.environment}"

  role    = aws_iam_role.lambda_exec.arn
  runtime = "nodejs20.x"
  handler = "index.handler"

  filename         = "${path.module}/lambda_tasks.zip"
  source_code_hash = filebase64sha256("${path.module}/lambda_tasks.zip")

  timeout     = 15
  memory_size = 256

  environment {
    variables = {
      TASKS_TABLE_NAME = aws_dynamodb_table.tasks.name
      AUDIO_BUCKET     = aws_s3_bucket.audio.bucket
      REGION           = var.aws_region
    }
  }
}

###########################################
#  API GATEWAY HTTP API (mit Cognito JWT)
###########################################

resource "aws_apigatewayv2_api" "http_api" {
  name          = "${var.project_name}-http-api-${var.environment}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
  }
}

resource "aws_apigatewayv2_integration" "lambda_integration" {
  api_id                 = aws_apigatewayv2_api.http_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.tasks_api.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id          = aws_apigatewayv2_api.http_api.id
  name            = "cognito-auth"
  authorizer_type = "JWT"

  lifecycle {
    create_before_destroy = true
    ignore_changes = [
      name
    ]
  }

  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.this.id}"
    audience = [aws_cognito_user_pool_client.this.id]
  }
}

resource "aws_apigatewayv2_route" "root" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "ANY /"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"

  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "proxy" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"

  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "options_proxy" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "OPTIONS /{proxy+}"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}


resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http_api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "allow_api" {
  statement_id  = "AllowAPIGWInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tasks_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http_api.execution_arn}/*/*"
}

###########################################
#  FRONTEND S3 BUCKET
###########################################

resource "aws_s3_bucket" "frontend" {
  bucket = "${var.project_name}-frontend-${var.environment}-${random_string.suffix.result}"
}

resource "aws_s3_bucket_public_access_block" "frontend_public" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_website_configuration" "frontend_website" {
  bucket = aws_s3_bucket.frontend.id

  index_document {
    suffix = "index.html"
  }
}

###########################################
#  CLOUD FRONT OAC
###########################################

resource "aws_cloudfront_origin_access_control" "oac" {
  name                              = "tadone-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

###########################################
#  ROUTE53-ZONE (explizit über zone_id)
###########################################

data "aws_route53_zone" "main" {
  zone_id = "Z09645642QWJY8XEPXSNJ"
}

###########################################
#  ACM CERTIFICATE (us-east-1 für CloudFront)
###########################################

resource "aws_acm_certificate" "cert" {
  provider          = aws.us
  domain_name       = "tadone.leitnersoft.com"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  cert_validation = tolist(aws_acm_certificate.cert.domain_validation_options)[0]
}

resource "aws_route53_record" "cert_validation" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.cert_validation.resource_record_name
  type    = local.cert_validation.resource_record_type
  ttl     = 300
  records = [local.cert_validation.resource_record_value]
}

resource "aws_acm_certificate_validation" "cert_validation" {
  provider                = aws.us
  certificate_arn         = aws_acm_certificate.cert.arn
  validation_record_fqdns = [aws_route53_record.cert_validation.fqdn]
}

###########################################
#  CLOUD FRONT DISTRIBUTION
###########################################

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"

  aliases = ["tadone.leitnersoft.com"]


  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "frontend-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.oac.id

    s3_origin_config {
      origin_access_identity = ""
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "frontend-s3"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  price_class = "PriceClass_100"

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cert_validation.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

###########################################
#  S3 BUCKET POLICY (OAC / 403 Fix)
###########################################

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_policy" "frontend_policy" {
  bucket = aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid      = "AllowCloudFrontAccess",
        Effect   = "Allow",
        Principal = {
          Service = "cloudfront.amazonaws.com"
        },
        Action   = "s3:GetObject",
        Resource = "${aws_s3_bucket.frontend.arn}/*",
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${aws_cloudfront_distribution.frontend.id}"
          }
        }
      }
    ]
  })
}

###########################################
#  ROUTE53 A-RECORD für tadone.leitnersoft.com
###########################################

resource "aws_route53_record" "frontend" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "tadone.leitnersoft.com"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

###########################################
#  OUTPUTS
###########################################

output "audio_bucket_name" {
  value = aws_s3_bucket.audio.bucket
}

output "dynamodb_tasks_table_name" {
  value = aws_dynamodb_table.tasks.name
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "cognito_user_pool_client_id" {
  value = aws_cognito_user_pool_client.this.id
}

output "http_api_endpoint" {
  value = aws_apigatewayv2_api.http_api.api_endpoint
}

output "frontend_bucket" {
  value = aws_s3_bucket.frontend.bucket
}

output "frontend_cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.frontend.id
}

output "frontend_domain" {
  value = aws_route53_record.frontend.fqdn
}

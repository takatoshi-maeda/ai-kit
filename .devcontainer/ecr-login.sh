#!/bin/bash

set -euo pipefail

ecr_registry="${VIBEBOX_ECR_REGISTRY:-}"
aws_region="${VIBEBOX_AWS_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"

if [[ -z "$ecr_registry" ]]; then
    echo "Skipping ECR login: VIBEBOX_ECR_REGISTRY is not set."
    exit 0
fi

if [[ -z "$aws_region" ]]; then
    echo "Skipping ECR login: VIBEBOX_AWS_REGION/AWS_REGION is not set."
    exit 0
fi

aws ecr get-login-password --region "$aws_region" | docker login --username AWS --password-stdin "$ecr_registry"

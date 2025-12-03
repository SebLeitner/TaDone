#!/usr/bin/env bash
set -e

FRONTEND_DIR="./frontend"
BUCKET="tadone-frontend-prod-vf4aqq3w"
DISTRIBUTION_ID="E246SLQ4S6PSI"

echo "🚀 Deploying Ta-Done Frontend..."

aws s3 sync "$FRONTEND_DIR/" "s3://$BUCKET/" --delete


echo "📦 Fix JS MIME types..."
for f in $FRONTEND_DIR/js/*.js; do
  base=$(basename $f)
  aws s3 cp "$f" "s3://$BUCKET/js/$base" \
    --content-type "application/javascript" \
    --cache-control "no-cache" \
    --metadata-directive REPLACE
done

echo "📦 Fix HTML..."
aws s3 cp "$FRONTEND_DIR/index.html" "s3://$BUCKET/index.html" \
  --content-type "text/html" \
  --cache-control "no-store" \
  --metadata-directive REPLACE

echo "📦 Fix service worker..."
aws s3 cp "$FRONTEND_DIR/service-worker.js" "s3://$BUCKET/service-worker.js" \
  --content-type "application/javascript" \
  --cache-control "no-store" \
  --metadata-directive REPLACE || true

echo "📦 Fix manifest..."
aws s3 cp "$FRONTEND_DIR/manifest.json" "s3://$BUCKET/manifest.json" \
  --content-type "application/manifest+json" \
  --cache-control "no-store" \
  --metadata-directive REPLACE || true


echo "🧹 CloudFront Invalidation..."
aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "/*"

echo "🎉 Deployment complete!"

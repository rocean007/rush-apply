#!/bin/bash

# Production deployment script
set -e

echo "🚀 Starting deployment..."

# Pull latest changes (if using git)
# git pull origin main

# Create necessary directories
mkdir -p data logs

# Set proper permissions
chmod 755 data logs

# Build and start containers
docker-compose down
docker-compose build --no-cache
docker-compose up -d

# Wait for container to be ready
echo "⏳ Waiting for container to be ready..."
sleep 10

# Check health
if curl -f http://localhost:3000/health; then
    echo "✅ Deployment successful!"
    docker-compose logs --tail=50
else
    echo "❌ Health check failed!"
    docker-compose logs --tail=50
    exit 1
fi
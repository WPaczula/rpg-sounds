#!/bin/bash

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}GK150 Soundboard Launcher${NC}"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}📦 Installing dependencies...${NC}"
    npm install
    echo ""
fi

# Rebuild native modules (required for node-hid)
echo -e "${BLUE}🔨 Rebuilding native modules...${NC}"
npx electron-rebuild -f -w node-hid

echo ""
echo -e "${GREEN}✅ Starting the app...${NC}"
echo ""

# Start the app
npm start

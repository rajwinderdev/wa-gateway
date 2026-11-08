FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies (production only)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code and scripts
COPY . .

# Expose HTTP port
EXPOSE 3000

# Run in production mode with low memory flag
ENV NODE_ENV=production
CMD ["node", "--max-old-space-size=400", "src/server.js"]

FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/

# Install dependencies
RUN npm run install:all

# Copy application source code
COPY . .

# Build the React frontend
RUN npm run build

# Default environment variables
ENV NODE_ENV=production
ENV PORT=4000
ENV DB_PATH=/app/data/kanban.db

# Ensure database directory exists
RUN mkdir -p /app/data

EXPOSE 4000

VOLUME ["/app/data"]

CMD ["npm", "start"]


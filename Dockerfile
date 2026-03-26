FROM ghcr.io/puppeteer/puppeteer:latest

# Set working directory
WORKDIR /usr/src/app

# Copy package files natively as the correct user to ensure Chrome caches in their home directory
COPY --chown=pptruser:pptruser package*.json ./

# Install dependencies
RUN npm install
RUN npx puppeteer browsers install chrome

# Copy application source
COPY --chown=pptruser:pptruser . .

# Expose port (Render sets PORT env)
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]

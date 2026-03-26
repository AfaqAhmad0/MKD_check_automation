FROM ghcr.io/puppeteer/puppeteer:latest

# Set working directory
WORKDIR /usr/src/app

# Need to be root to chown copied files
USER root

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application source
COPY . .

# Claim permissions over the app directory so the app can create folders if needed
RUN chown -R pptruser:pptruser /usr/src/app

# Switch back to the non-privileged Puppeteer user for security
USER pptruser


# Expose port (Render sets PORT env)
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]

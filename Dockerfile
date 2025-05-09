# Use Node.js as base image
FROM node:18-bullseye

# Install dependencies for whisper.cpp
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    cmake \
    wget \
    make \
    g++ \
    curl \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Clone and build Whisper.cpp
WORKDIR /app
RUN git clone https://github.com/ggerganov/whisper.cpp.git
WORKDIR /app/whisper.cpp
RUN make

# Download a model (medium model by default)
RUN bash ./models/download-ggml-model.sh tiny

# Create Node.js API application
WORKDIR /app/api
COPY package.json package-lock.json* ./
RUN npm install

# Copy application code
COPY . .

# Expose port for the Node.js API
EXPOSE 3000

# Start the API server
CMD ["node", "server.js"]

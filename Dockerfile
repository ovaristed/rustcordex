
FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev --no-audit --no-fund --prefer-offline

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]

FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --include=dev

COPY . .
RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production

CMD ["node", "dist/src/main.js"]

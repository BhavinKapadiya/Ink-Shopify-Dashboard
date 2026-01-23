FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Generate Prisma client at build time
RUN npx prisma generate

RUN npm run build

# Start server directly without db push (schema should already exist)
CMD ["npm", "run", "start"]

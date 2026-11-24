# The long-work spike (#14): one image for the services (`serve`) and the job (`job`). Throwaway.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src/work.ts src/main.ts ./
USER node
ENV PORT=8080
ENTRYPOINT ["node", "main.ts"]
CMD ["serve"]

FROM node:18

RUN npm install -g pnpm

# 👇 Set PNPM_HOME (pnpm needs this for global installs)
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

COPY package*.json ./

RUN pnpm install

COPY . .

RUN pnpm add -g nodemon 

EXPOSE 5000

CMD ["pnpm", "run", "test"]

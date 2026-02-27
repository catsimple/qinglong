FROM python:3.11-alpine3.18 AS builder
COPY package.json .npmrc pnpm-lock.yaml /tmp/build/
RUN set -x \
  && apk update \
  && apk add nodejs npm git \
  && npm i -g pnpm@8.3.1 pm2 ts-node \
  && cd /tmp/build \
  && pnpm install --prod

FROM python:3.11-alpine

ARG QL_MAINTAINER="whyour"
LABEL maintainer="${QL_MAINTAINER}"
ARG QL_BRANCH=develop

ENV PNPM_HOME=/root/.local/share/pnpm \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/share/pnpm:/root/.local/share/pnpm/global/5/node_modules \
  NODE_PATH=/usr/local/bin:/usr/local/pnpm-global/5/node_modules:/usr/local/lib/node_modules:/root/.local/share/pnpm/global/5/node_modules \
  LANG=C.UTF-8 \
  SHELL=/bin/bash \
  PS1="\u@\h:\w \$ " \
  QL_DIR=/ql \
  QL_BRANCH=${QL_BRANCH}

VOLUME /ql/data
EXPOSE 5700

COPY --from=builder /usr/local/lib/node_modules/. /usr/local/lib/node_modules/
COPY --from=builder /usr/local/bin/. /usr/local/bin/

RUN set -x \
  && apk update -f \
  && apk upgrade \
  && apk --no-cache add -f bash \
  coreutils git curl wget tzdata perl openssl nginx nodejs jq openssh procps netcat-openbsd unzip npm \
  && rm -rf /var/cache/apk/* \
  && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo "Asia/Shanghai" > /etc/timezone \
  && git config --global user.email "qinglong@users.noreply.github.com" \
  && git config --global user.name "qinglong" \
  && pip3 install requests

ARG SOURCE_COMMIT
WORKDIR ${QL_DIR}

COPY . ${QL_DIR}

RUN chmod 777 ${QL_DIR}/shell/*.sh \
  && chmod 777 ${QL_DIR}/docker/*.sh \
  && cp -f .env.example .env

# 如果你手动编译了前端，static 文件夹已经存在。
# 如果你还是想用远程的 static，可以保留下面这行，否则建议删掉
# RUN git clone --depth=1 -b ${QL_BRANCH} https://github.com/${QL_MAINTAINER}/qinglong-static.git /ql/static

COPY --from=builder /tmp/build/node_modules/. /ql/node_modules/

HEALTHCHECK --interval=5s --timeout=2s --retries=20 \
  CMD curl -sf --noproxy '*' http://127.0.0.1:5400/api/health || exit 1

ENTRYPOINT ["./docker/docker-entrypoint.sh"]

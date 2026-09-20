# QuestionForge 运行镜像
# 后端只用 Node 内置模块 + mysql2；资料解析走 Python 子进程（parse.py），
# 因此镜像里同时需要 node 与 python3，以及 PDF/OCR/图片处理依赖。
FROM node:20-bookworm-slim

# ---- 系统与 Python 依赖 ----
# pymupdf      抽取 PDF 文字与内嵌图片
# pillow       图片尺寸/格式处理
# pytesseract  + tesseract-ocr-chi-sim：扫描页本地 OCR（离线、免费）
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      tesseract-ocr tesseract-ocr-chi-sim \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖装进系统环境即可（parse.py 只用这几个库）
RUN pip3 install --no-cache-dir --break-system-packages pymupdf pillow pytesseract

WORKDIR /app

# ---- Node 依赖（先拷贝清单，利用镜像层缓存）----
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---- 源码 ----
COPY server.js runtests.js apicheck.js viewaudit.js feature_test.js simcal.js fixfigs.js cleandata.js ./
COPY lib/ ./lib/
COPY web/ ./web/
COPY docs/ ./docs/

# 运行时数据（图片/科目包/日志）挂载出来，容器重建不丢
VOLUME ["/app/data"]
ENV QF_DB_HOST=mysql QF_DB_PORT=3306 QF_DB_NAME=questionforge QF_PORT=8540

EXPOSE 8540
# 健康检查直接用内置的 /api/health（含数据库连通性）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8540/api/health || exit 1

CMD ["node", "server.js"]

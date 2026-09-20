# -*- coding: utf-8 -*-
"""资料解析助手 v2：PDF/Word/文本 → 结构化内容（文字 + 图形），供制题 Agent 使用

三种页面内容分别处理：
  1. 原生文字页        → 直接提取文字（免费、无损）
  2. 扫描版文字页      → 本地 tesseract OCR 兜底（免费、离线，公式上下标可能失真）
  3. 含图形的页/内嵌图 → 抽取原图交视觉模型（GLM-4V）做结构化描述

用法: python parse.py <文件路径> [<图片输出目录>]
输出: JSON（stdout 最后一行）
  {
    ok, kind, pages, chars, text,            # 全文
    images: [{id, page, file, w, h, kb, source}],   # 抽取的图片（含绝对路径）
    scanPages: [页号...],                     # 走了 OCR 的页
    figurePages: [页号...],                   # 含图形、建议视觉识别的页
    stats: {nativePages, ocrPages, imageCount}, warnings: [...]
  }
"""
import json, io, os, re, sys, zipfile

MIN_TEXT_CHARS = 100      # 低于此字数视为"文字稀疏页"
MIN_IMG_SIDE = 120        # 小于此边长的图视为图标/装饰，跳过
MAX_IMG_SIDE = 1600       # 抽出的图超过此边长则降采样（控体积与 token）
JPEG_QUALITY = 82


def _save_image(data, outdir, name, force_ext=None):
    """保存图片，超过 MAX_IMG_SIDE 则等比降采样"""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        if force_ext:
            img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > MAX_IMG_SIDE:
            scale = MAX_IMG_SIDE / float(max(w, h))
            img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        path = os.path.join(outdir, name + ".jpg")
        img.convert("RGB").save(path, "JPEG", quality=JPEG_QUALITY, optimize=True)
        return path, img.size[0], img.size[1]
    except Exception:
        # PIL 不可用时原样落盘
        ext = force_ext or "png"
        path = os.path.join(outdir, name + "." + ext)
        with open(path, "wb") as f:
            f.write(data)
        return path, 0, 0


def parse_pdf(path, outdir):
    import pymupdf
    doc = pymupdf.open(path)
    texts, images, scan_pages, figure_pages, warnings = [], [], [], [], []
    ocr_pages = 0

    for pno, page in enumerate(doc):
        native = page.get_text().strip()
        raw_imgs = page.get_images(full=True)

        # ---- 抽取内嵌位图（图形题的载体）----
        kept = 0
        for i, im in enumerate(raw_imgs):
            try:
                info = doc.extract_image(im[0])
            except Exception:
                continue
            w, h = info.get("width", 0), info.get("height", 0)
            if max(w, h) < MIN_IMG_SIDE:      # 图标/线条装饰
                continue
            name = "p%02d_img%02d" % (pno + 1, i + 1)
            fpath, nw, nh = _save_image(info["image"], outdir, name, info.get("ext"))
            images.append({
                "id": name, "page": pno + 1,
                "file": os.path.abspath(fpath),
                "w": nw or w, "h": nh or h,
                "kb": round(os.path.getsize(fpath) / 1024.0, 1),
                "source": "embedded"
            })
            kept += 1

        # ---- 页分类 ----
        if len(native) >= MIN_TEXT_CHARS:
            texts.append(native)
            if kept:
                figure_pages.append(pno + 1)   # 有文字也有图 → 图交给视觉通道
        else:
            # 文字稀疏：要么是扫描页，要么是整页的图（数据结构图常见）
            if kept:
                figure_pages.append(pno + 1)
                if native:
                    texts.append(native)
            else:
                # 无内嵌图 → 整页渲染，先本地 OCR 兜底
                ocr_txt = _ocr_page(page)
                if ocr_txt:
                    texts.append(ocr_txt)
                    ocr_pages += 1
                    scan_pages.append(pno + 1)
                # 同时把整页渲染成图，供视觉模型读取（扫描页的图表 OCR 读不出）
                render = _render_page(page, outdir, "p%02d_full" % (pno + 1))
                if render:
                    fp, nw, nh = render
                    images.append({
                        "id": "p%02d_full" % (pno + 1), "page": pno + 1,
                        "file": os.path.abspath(fp), "w": nw, "h": nh,
                        "kb": round(os.path.getsize(fp) / 1024.0, 1),
                        "source": "render"
                    })
                    if pno + 1 not in figure_pages:
                        figure_pages.append(pno + 1)
                elif not ocr_txt:
                    warnings.append("第 %d 页未提取到文字，且渲染失败" % (pno + 1))

    return {
        "text": "\n".join(texts),
        "pages": len(doc),
        "images": images,
        "scanPages": scan_pages,
        "figurePages": sorted(set(figure_pages)),
        "stats": {"nativePages": len(doc) - ocr_pages, "ocrPages": ocr_pages, "imageCount": len(images)},
        "warnings": warnings
    }


def _render_page(page, outdir, name):
    try:
        pix = page.get_pixmap(dpi=150)
        return _save_image(pix.tobytes("png"), outdir, name)
    except Exception:
        return None


def _ocr_page(page):
    """本地 tesseract OCR（中文简体+英文）；失败返回空串（不阻断流程）"""
    try:
        import pytesseract
        from PIL import Image
        pix = page.get_pixmap(dpi=200)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        return pytesseract.image_to_string(img, lang="chi_sim+eng").strip()
    except Exception:
        return ""


def parse_docx(path, outdir):
    """docx = zip 包；正文取 document.xml，内嵌图取 word/media/*"""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
        xml2 = re.sub(r"<w:p[ >]", "\n<w:p ", xml)
        text = re.sub(r"\n{3,}", "\n\n", "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", xml2)))
        images = []
        for nm in z.namelist():
            if nm.startswith("word/media/"):
                data = z.read(nm)
                base = os.path.splitext(os.path.basename(nm))[0]
                fp, w, h = _save_image(data, outdir, "docx_" + base)
                images.append({"id": "docx_" + base, "page": None, "file": os.path.abspath(fp),
                               "w": w, "h": h, "kb": round(os.path.getsize(fp) / 1024.0, 1), "source": "embedded"})
    return {"text": text, "pages": None, "images": images, "scanPages": [], "figurePages": [],
            "stats": {"nativePages": None, "ocrPages": 0, "imageCount": len(images)}, "warnings": []}


def parse_txt(path):
    for enc in ("utf-8", "gbk", "utf-16"):
        try:
            with open(path, "r", encoding=enc) as f:
                t = f.read()
            return {"text": t, "pages": None, "images": [], "scanPages": [], "figurePages": [],
                    "stats": {"nativePages": None, "ocrPages": 0, "imageCount": 0}, "warnings": []}
        except UnicodeDecodeError:
            continue
    raise ValueError("无法识别文本编码")


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "用法: python parse.py <文件> [图片目录]"}))
        return
    path = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(path)), "images")
    os.makedirs(outdir, exist_ok=True)
    low = path.lower()
    try:
        if low.endswith(".pdf"):
            r = parse_pdf(path, outdir)
            kind = "pdf"
        elif low.endswith(".docx"):
            r = parse_docx(path, outdir)
            kind = "docx"
        elif low.endswith((".txt", ".md")):
            r = parse_txt(path)
            kind = "txt"
        else:
            raise ValueError("不支持的格式（支持 pdf/docx/txt/md）")
        print(json.dumps({
            "ok": True, "kind": kind, "pages": r["pages"],
            "chars": len(r["text"].strip()), "text": r["text"][:300000],
            "images": r["images"], "scanPages": r["scanPages"], "figurePages": r["figurePages"],
            "stats": r["stats"], "warnings": r["warnings"]
        }, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

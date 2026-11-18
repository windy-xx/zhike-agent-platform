/**
 * 文件上传路由
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, logAction } = require('../db');
const { authMiddleware, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// 使用 process.cwd() 兼容 pkg 打包
const baseDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..', '..');
const uploadDir = path.join(baseDir, 'data', 'uploads');

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 }
});

fs.mkdirSync(uploadDir, { recursive: true });

/**
 * 中医术语关键词提取
 */
function extractKeywords(text) {
  const tcmTerms = [
    '阴阳', '五行', '气血', '经络', '脏腑', '辨证', '论治', '望闻问切',
    '四诊', '八纲', '六淫', '七情', '伤寒', '温病', '营卫', '津液',
    '心肝', '脾肺', '肾命', '肝郁', '脾虚', '肾阳', '肾阴', '心血',
    '肺气', '胃火', '肝火', '湿热', '寒湿', '痰饮', '瘀血', '气滞',
    '活血', '化瘀', '清热', '解毒', '祛风', '散寒', '除湿', '理气',
    '补气', '养血', '滋阴', '温阳', '安神', '开窍', '固涩', '涌吐',
    '中药', '方剂', '针灸', '推拿', '拔罐', '刮痧', '艾灸', '穴位',
    '汤剂', '丸剂', '散剂', '膏方', '丹剂', '炮制', '配伍', '君臣佐使',
    '麻黄', '桂枝', '柴胡', '黄芩', '人参', '黄芪', '当归', '白术',
    '茯苓', '甘草', '川芎', '白芍', '熟地', '生地', '半夏', '陈皮',
    '附子', '干姜', '大黄', '芒硝', '黄连', '黄柏', '栀子', '石膏',
    '知母', '天花粉', '麦冬', '五味子', '山茱萸', '枸杞子', '菊花',
    '薄荷', '藿香', '苍术', '厚朴', '砂仁', '豆蔻', '薏苡仁',
    '太阳', '阳明', '少阳', '太阴', '少阴', '厥阴', '卫气', '营血',
    '任脉', '督脉', '冲脉', '带脉', '足三里', '合谷', '太冲', '百会',
    '关元', '气海', '神阙', '命门', '内关', '外关', '三阴交',
    '麻黄汤', '桂枝汤', '小柴胡汤', '大柴胡汤', '四物汤', '四君子汤',
    '六味地黄丸', '逍遥散', '白虎汤', '承气汤', '理中丸', '真武汤',
    '归脾汤', '越鞠丸', '半夏泻心汤', '黄连解毒汤', '龙胆泻肝汤',
    '银翘散', '桑菊饮', '藿香正气散', '保和丸', '血府逐瘀汤',
    '补阳还五汤', '天王补心丹', '酸枣仁汤', '朱砂安神丸'
  ];
  const found = tcmTerms.filter(term => text.includes(term));
  return [...new Set(found)].slice(0, 20);
}

router.post('/', optionalAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未提供文件' });
  }

  const { originalname, mimetype, path: filePath, size } = req.file;
  const ext = path.extname(originalname).toLowerCase().replace('.', '');
  const fileId = uuidv4();

  let rawText = '';
  let fileType = ext;

  try {
    switch (ext) {
      case 'pdf': {
        const pdfParse = require('pdf-parse');
        const buffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(buffer);
        rawText = pdfData.text || '';
        break;
      }
      case 'doc':
      case 'docx': {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ path: filePath });
        rawText = result.value || '';
        break;
      }
      case 'txt':
      case 'md': {
        rawText = fs.readFileSync(filePath, 'utf-8');
        break;
      }
      case 'ppt':
      case 'pptx': {
        rawText = `[PPT文件: ${originalname}]（PPT内容解析需要上传到支持Office的服务器）`;
        break;
      }
      case 'jpg':
      case 'jpeg':
      case 'png':
      case 'gif': {
        rawText = `[图片文件: ${originalname}, ${size}字节]`;
        fileType = 'image';
        break;
      }
      case 'mp4':
      case 'avi': {
        rawText = `[视频文件: ${originalname}, ${size}字节]`;
        fileType = 'video';
        break;
      }
      case 'mp3':
      case 'wav': {
        rawText = `[音频文件: ${originalname}, ${size}字节]`;
        fileType = 'audio';
        break;
      }
      default: {
        rawText = fs.readFileSync(filePath, 'utf-8').slice(0, 100000);
      }
    }

    const keywords = extractKeywords(rawText);
    const summary = rawText.length > 0
      ? rawText.slice(0, 500).replace(/\n+/g, ' ').trim()
      : '未能提取文本内容';

    const analysis = { summary, keywords, charCount: rawText.length, fileType };

    db.prepare(`
      INSERT INTO uploads (id, user_id, filename, file_type, raw_text, analysis)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(fileId, req.user?.id || null, originalname, fileType, rawText, JSON.stringify(analysis));

    logAction('file_upload', { userId: req.user?.id, resourceId: fileId, detail: `上传 ${originalname}`, ip: req.ip });

    res.json({
      id: fileId,
      filename: originalname,
      fileType,
      rawText: rawText.slice(0, 50000),
      analysis,
      size
    });
  } catch (e) {
    console.error('[Upload Parse Error]', e.message);
    res.json({
      id: fileId,
      filename: originalname,
      fileType: ext,
      rawText: '',
      analysis: { summary: '文件解析失败: ' + e.message, keywords: [], charCount: 0, fileType: ext },
      size,
      error: e.message
    });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
});

module.exports = router;

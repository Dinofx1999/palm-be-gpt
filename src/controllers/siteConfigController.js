// backend/src/controllers/siteConfigController.js
const SiteConfig = require('../models/SiteConfig');

// GET /api/public/site-config — hero slides + tiện nghi chung (public)
const publicGet = async (req, res, next) => {
  try {
    const cfg = await SiteConfig.getSingleton();
    res.json({ success: true, data: { brand: cfg.brand || {}, heroSlides: cfg.heroSlides || [], amenities: cfg.amenities || [] } });
  } catch (err) { next(err); }
};

// GET /api/site-config — cho trang quản lý (cần auth)
const getConfig = async (req, res, next) => {
  try {
    const cfg = await SiteConfig.getSingleton();
    res.json({ success: true, data: { config: cfg } });
  } catch (err) { next(err); }
};

// PUT /api/site-config — cập nhật hero + tiện nghi (cần auth)
const updateConfig = async (req, res, next) => {
  try {
    const cfg = await SiteConfig.getSingleton();
    if (req.body.brand && typeof req.body.brand === 'object') cfg.brand = { ...cfg.brand?.toObject?.() ?? cfg.brand, ...req.body.brand };
    if (Array.isArray(req.body.heroSlides)) cfg.heroSlides = req.body.heroSlides;
    if (Array.isArray(req.body.amenities)) cfg.amenities = req.body.amenities;
    await cfg.save();
    res.json({ success: true, message: 'Cập nhật cấu hình thành công', data: { config: cfg } });
  } catch (err) { next(err); }
};

module.exports = { publicGet, getConfig, updateConfig };
// backend/scripts/seedChatFewShots.js
// ============================================================
// Chạy: node backend/scripts/seedChatFewShots.js
// Hoặc thêm npm script: "seed:fewshots": "node scripts/seedChatFewShots.js"
// ============================================================

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const ChatFewShot = require('../src/models/ChatFewShot');

async function seed() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/palm-pms');
    console.log('✓ Connected to MongoDB');

    const seedPath = path.join(__dirname, '../src/data/chat-fewshots-seed.json');
    const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));

    console.log(`📦 Found ${seedData.length} examples in seed file`);

    let inserted = 0, skipped = 0;
    for (const item of seedData) {
      // Skip nếu đã tồn tại (cùng title)
      const exists = await ChatFewShot.findOne({ title: item.title, source: 'seed' });
      if (exists) {
        skipped++;
        continue;
      }

      await ChatFewShot.create({
        ...item,
        source: 'seed',
      });
      inserted++;
    }

    console.log(`✅ Done! Inserted: ${inserted}, Skipped (already exist): ${skipped}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed error:', err);
    process.exit(1);
  }
}

seed();
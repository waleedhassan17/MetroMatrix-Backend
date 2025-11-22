#!/usr/bin/env node

/**
 * Upload Cleanup Cron Job
 * 
 * This script cleans up temporary files and old uploads.
 * Run this as a cron job daily:
 * 
 * # Add to crontab (crontab -e)
 * 0 2 * * * /path/to/backend/scripts/cleanupUploads.js
 * 
 * Or run manually:
 * node scripts/cleanupUploads.js
 */

const path = require('path');
const fs = require('fs').promises;
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

const log = (message, color = 'reset') => {
  console.log(`${colors[color]}${message}${colors.reset}`);
};

/**
 * Clean up temporary files older than 24 hours
 */
const cleanupTempFiles = async () => {
  try {
    const tempDir = path.join(__dirname, '../uploads/temp');
    const files = await fs.readdir(tempDir);
    
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    let deletedCount = 0;
    let totalSize = 0;
    
    for (const file of files) {
      if (file === '.gitkeep' || file === '.htaccess') continue;
      
      const filePath = path.join(tempDir, file);
      
      try {
        const stats = await fs.stat(filePath);
        
        // Delete files older than 24 hours
        if (now - stats.mtimeMs > maxAge) {
          totalSize += stats.size;
          await fs.unlink(filePath);
          deletedCount++;
          log(`  ✓ Deleted: ${file}`, 'cyan');
        }
      } catch (error) {
        log(`  ✗ Error processing ${file}: ${error.message}`, 'red');
      }
    }
    
    const sizeInMB = (totalSize / (1024 * 1024)).toFixed(2);
    
    return {
      deleted: deletedCount,
      size: sizeInMB
    };
    
  } catch (error) {
    log(`Error cleaning temp files: ${error.message}`, 'red');
    throw error;
  }
};

/**
 * Get directory size
 */
const getDirectorySize = async (dirPath) => {
  try {
    const files = await fs.readdir(dirPath, { withFileTypes: true });
    let totalSize = 0;
    
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      
      if (file.isDirectory()) {
        totalSize += await getDirectorySize(filePath);
      } else {
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
      }
    }
    
    return totalSize;
  } catch (error) {
    return 0;
  }
};

/**
 * Get upload statistics
 */
const getUploadStats = async () => {
  const uploadsDir = path.join(__dirname, '../uploads');
  
  const categories = [
    'users/profiles',
    'providers/profiles',
    'providers/doctors/medical-licenses',
    'providers/doctors/degree-certificates',
    'providers/doctors/national-ids',
    'providers/home-services/professional-certificates',
    'providers/home-services/national-ids',
    'providers/vendors/business-licenses',
    'providers/vendors/national-ids',
    'posts/images',
    'temp'
  ];
  
  const stats = {};
  
  for (const category of categories) {
    const dirPath = path.join(uploadsDir, category);
    try {
      const files = await fs.readdir(dirPath);
      const fileCount = files.filter(f => f !== '.gitkeep' && f !== '.htaccess').length;
      const size = await getDirectorySize(dirPath);
      
      stats[category] = {
        count: fileCount,
        size: (size / (1024 * 1024)).toFixed(2) // Convert to MB
      };
    } catch (error) {
      stats[category] = { count: 0, size: 0 };
    }
  }
  
  return stats;
};

/**
 * Main cleanup function
 */
const runCleanup = async () => {
  log('\n🧹 Starting Upload Cleanup...', 'cyan');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n', 'cyan');
  
  const startTime = Date.now();
  
  try {
    // Get stats before cleanup
    log('📊 Gathering statistics...', 'blue');
    const statsBefore = await getUploadStats();
    
    // Clean up temp files
    log('\n🗑️  Cleaning temporary files...', 'yellow');
    const tempCleanup = await cleanupTempFiles();
    
    if (tempCleanup.deleted > 0) {
      log(`\n✅ Deleted ${tempCleanup.deleted} temporary files (${tempCleanup.size} MB)`, 'green');
    } else {
      log('\n✅ No temporary files to clean', 'green');
    }
    
    // Get stats after cleanup
    const statsAfter = await getUploadStats();
    
    // Display statistics
    log('\n📈 Upload Directory Statistics:', 'cyan');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n', 'cyan');
    
    log('Category                              Files    Size (MB)', 'blue');
    log('────────────────────────────────────────────────────────', 'blue');
    
    let totalFiles = 0;
    let totalSize = 0;
    
    for (const [category, data] of Object.entries(statsAfter)) {
      const paddedCategory = category.padEnd(40);
      const paddedCount = String(data.count).padStart(5);
      const paddedSize = String(data.size).padStart(10);
      
      log(`${paddedCategory}${paddedCount}${paddedSize}`, 'cyan');
      
      totalFiles += data.count;
      totalSize += parseFloat(data.size);
    }
    
    log('────────────────────────────────────────────────────────', 'blue');
    log(`${'Total'.padEnd(40)}${String(totalFiles).padStart(5)}${totalSize.toFixed(2).padStart(10)}`, 'green');
    
    // Execution time
    const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
    
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'cyan');
    log(`✅ Cleanup completed in ${executionTime}s`, 'green');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n', 'cyan');
    
    process.exit(0);
    
  } catch (error) {
    log(`\n❌ Cleanup failed: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
  }
};

// Run cleanup if executed directly
if (require.main === module) {
  runCleanup();
}

module.exports = {
  cleanupTempFiles,
  getUploadStats,
  runCleanup
};
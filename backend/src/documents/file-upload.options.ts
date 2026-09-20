import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface.js';
import { extname } from 'node:path';
import { memoryStorage } from 'multer';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv', '.pdf']);

export const documentUploadOptions: MulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req: Express.Request, file: Express.Multer.File, callback: (error: Error | null, acceptFile: boolean) => void) => {
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      callback(new BadRequestException(`Unsupported file type: ${ext || 'unknown'}`), false);
      return;
    }
    callback(null, true);
  },
};

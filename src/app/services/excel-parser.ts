import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import * as XLSX from 'xlsx';
import { environment } from '../../environments/environment';
import { ClaudeService } from './claude';

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Record<string, any>[];
}

export type FileType = 'excel' | 'pdf';

export interface UploadedFile {
  name: string;
  type: FileType;
  sheets?: ParsedSheet[];   // for Excel
  base64?: string;          // for PDF
  documentId?: string;      // backend Document id, once persisted
}

@Injectable({ providedIn: 'root' })
export class ExcelParserService {
  private readonly http = inject(HttpClient);
  private readonly claude = inject(ClaudeService);

  async parseFile(file: File): Promise<UploadedFile> {
    const isPdf = file.name.toLowerCase().endsWith('.pdf');

    const uploaded: UploadedFile = isPdf
      ? { name: file.name, type: 'pdf', base64: await this.fileToBase64(file) }
      : { name: file.name, type: 'excel', sheets: await this.parseExcel(file) };

    // For PDFs, this id is what lets the backend fetch the file back out of
    // Storage and hand it to Claude as a document block — it's not just
    // persistence bookkeeping. Excel's text context is still parsed above
    // and is unaffected either way.
    try {
      uploaded.documentId = await this.persistRawFile(file);
    } catch (err) {
      console.error(`Failed to persist "${file.name}" to the backend`, err);
    }

    return uploaded;
  }

  private async persistRawFile(file: File): Promise<string> {
    const conversationId = await this.claude.ensureConversation();
    const formData = new FormData();
    formData.append('file', file);

    const document = await firstValueFrom(
      this.http.post<{ id: string }>(
        `${environment.apiUrl}/conversations/${conversationId}/documents`,
        formData,
        { withCredentials: true }
      )
    );
    return document.id;
  }

  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        resolve(dataUrl.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  private parseExcel(file: File): Promise<ParsedSheet[]> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (e) => {
        try {
          const data = e.target?.result as ArrayBuffer;
          const workbook = XLSX.read(data, { type: 'array', cellDates: true });
          const sheets: ParsedSheet[] = [];

          for (const sheetName of workbook.SheetNames) {
            if (sheetName === 'Comments') continue;
            const ws = workbook.Sheets[sheetName];
            const json = XLSX.utils.sheet_to_json(ws, { defval: null }) as Record<string, any>[];
            if (json.length === 0) continue;

            sheets.push({
              name: sheetName,
              headers: Object.keys(json[0]),
              rows: json
            });
          }
          resolve(sheets);
        } catch (err) {
          reject(err);
        }
      };

      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  filesToContext(files: UploadedFile[]): string {
    const excelFiles = files.filter(f => f.type === 'excel' && f.sheets);

    if (excelFiles.length === 0) return '';

    return excelFiles.map(file => {
      const sheetsContext = file.sheets!.map(sheet => {
        const preview = sheet.rows.slice(0, 120);
        return `## Sheet: "${sheet.name}"\nColumns: ${sheet.headers.join(', ')}\nTotal rows: ${sheet.rows.length}\n\nData (JSON):\n${JSON.stringify(preview, null, 2)}`;
      }).join('\n\n');

      return `=== FILE: ${file.name} ===\n\n${sheetsContext}`;
    }).join('\n\n---\n\n');
  }
}

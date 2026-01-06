import { InvocationContext } from '@azure/functions';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  function: string;
  message: string;
  data?: Record<string, unknown>;
  contactId?: string;
  invoiceId?: string;
  error?: string;
}

export class Logger {
  private context: InvocationContext;
  private functionName: string;
  private contactId?: string;

  constructor(context: InvocationContext, functionName: string, contactId?: string) {
    this.context = context;
    this.functionName = functionName;
    this.contactId = contactId;
  }

  withContact(contactId: string): Logger {
    return new Logger(this.context, this.functionName, contactId);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      function: this.functionName,
      message,
      data,
      contactId: this.contactId,
    };

    const formatted = JSON.stringify(entry);

    switch (level) {
      case 'debug':
        this.context.debug(formatted);
        break;
      case 'info':
        this.context.log(formatted);
        break;
      case 'warn':
        this.context.warn(formatted);
        break;
      case 'error':
        this.context.error(formatted);
        break;
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, error?: Error, data?: Record<string, unknown>): void {
    this.log('error', message, {
      ...data,
      error: error?.message,
      stack: error?.stack,
    });
  }

  // Specific log methods for common operations
  invoiceProcessed(invoiceNumber: string, interest: number, action: 'charged' | 'skipped' | 'credited'): void {
    this.info(`Invoice ${invoiceNumber}: ${action}`, {
      invoiceNumber,
      interest,
      action,
    });
  }

  accrualComplete(contactName: string, totalInterest: number, invoiceCount: number): void {
    this.info(`Accrual complete for ${contactName}`, {
      contactName,
      totalInterest,
      invoiceCount,
    });
  }

  reconcileAction(sourceInvoiceNumber: string, action: 'credited' | 'voided', creditNoteId?: string): void {
    this.info(`Reconcile: ${sourceInvoiceNumber} ${action}`, {
      sourceInvoiceNumber,
      action,
      creditNoteId,
    });
  }
}

// Standalone logging for non-function contexts
export function createLogger(context: InvocationContext, functionName: string): Logger {
  return new Logger(context, functionName);
}

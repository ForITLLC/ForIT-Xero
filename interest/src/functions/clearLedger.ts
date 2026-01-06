import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getAllLedgerEntries, deleteLedgerEntry } from '../services/database';

/**
 * Clear all entries from the InterestLedger list
 * POST /api/admin/clear-ledger
 * Body: { dryRun?: boolean, contactId?: string }
 */
async function clearLedger(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = await request.json().catch(() => ({})) as {
      dryRun?: boolean;
      contactId?: string;
    };

    const { dryRun = true, contactId } = body;

    context.log(`Clearing ledger entries${contactId ? ` for contact ${contactId}` : ' (all)'}. dryRun=${dryRun}`);

    // Get all entries
    const allEntries = await getAllLedgerEntries();

    // Filter by contactId if specified
    const entriesToDelete = contactId
      ? allEntries.filter(e => e.contactId === contactId)
      : allEntries;

    context.log(`Found ${entriesToDelete.length} entries to delete`);

    if (!dryRun) {
      // Delete entries one by one
      let deleted = 0;
      const errors: string[] = [];

      for (const entry of entriesToDelete) {
        try {
          if (!entry.id) continue;
          await deleteLedgerEntry(entry.id);
          deleted++;
          if (deleted % 10 === 0) {
            context.log(`Deleted ${deleted}/${entriesToDelete.length} entries`);
          }
        } catch (error) {
          errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return {
        status: 200,
        jsonBody: {
          dryRun: false,
          totalFound: allEntries.length,
          entriesDeleted: deleted,
          errors: errors.length > 0 ? errors : undefined,
        },
      };
    }

    // Dry run - just show what would be deleted
    const summary = entriesToDelete.slice(0, 20).map(e => ({
      id: e.id,
      sourceInvoiceNumber: e.sourceInvoiceNumber,
      action: e.action,
      delta: e.delta,
      created: e.created,
    }));

    return {
      status: 200,
      jsonBody: {
        dryRun: true,
        totalFound: allEntries.length,
        entriesToDelete: entriesToDelete.length,
        sampleEntries: summary,
        message: 'Set dryRun=false in body to actually delete',
      },
    };

  } catch (error) {
    context.error('Clear ledger failed', error);
    return {
      status: 500,
      jsonBody: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

app.http('ClearLedger', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'admin/clear-ledger',
  handler: clearLedger,
});

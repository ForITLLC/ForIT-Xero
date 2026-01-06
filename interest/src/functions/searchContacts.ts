import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { searchContacts } from '../services/xero';
import { createLogger } from '../utils/logger';

/**
 * Search Contacts - Find Xero contacts by name
 * GET /api/contacts/search?q=WMA
 */
async function searchContactsHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context, 'SearchContacts');

  try {
    const searchTerm = request.query.get('q') || '';

    if (!searchTerm || searchTerm.length < 2) {
      return {
        status: 400,
        jsonBody: { error: 'Search term (q) must be at least 2 characters' },
      };
    }

    logger.info('Searching contacts', { searchTerm });

    const contacts = await searchContacts(searchTerm);

    return {
      status: 200,
      jsonBody: {
        searchTerm,
        count: contacts.length,
        contacts,
      },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Contact search failed', error instanceof Error ? error : new Error(errorMessage));

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

app.http('SearchContacts', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'contacts/search',
  handler: searchContactsHandler,
});

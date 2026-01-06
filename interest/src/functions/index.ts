// Function app entry point - imports all function definitions
// Azure Functions v4 programming model auto-registers via app.* calls
// Import executes the side effects (app.http(), app.timer() registrations)

import './monthlyAccrual';
import './monthlyRun';
import './reconcileVoided';
import './dryRun';
import './manualRun';
import './creditInterest';
import './reconcileReport';
import './authCallback';
import './searchContacts';
import './debugInvoices';
import './listInterestInvoices';
import './compareInterest';
import './mcpAuth';
import './voidInvoices';
import './debugVoided';
import './deleteInvoice';
import './migratePaidnice';
import './clearLedger';
import './checkInvoice';
import './exportInvoices';
import './approveInvoice';

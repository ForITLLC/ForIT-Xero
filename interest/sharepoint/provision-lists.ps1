# Provision Interest Accrual SharePoint Lists
# Run with: pwsh provision-lists.ps1
# Requires: PnP.PowerShell module

param(
    [string]$SiteUrl = "https://foritllc.sharepoint.com/finance/billing"
)

Write-Host "=== ForIT Interest Accrual - SharePoint Provisioning ===" -ForegroundColor Cyan
Write-Host ""

# Connect to SharePoint
Write-Host "Connecting to SharePoint..." -ForegroundColor Yellow
Connect-PnPOnline -Url $SiteUrl -Interactive

# ============================================
# InterestConfig List
# ============================================
$configListName = "InterestConfig"

$existingConfigList = Get-PnPList -Identity $configListName -ErrorAction SilentlyContinue

if ($existingConfigList) {
    Write-Host "List '$configListName' already exists. Skipping creation." -ForegroundColor Yellow
} else {
    Write-Host "Creating list '$configListName'..." -ForegroundColor Green

    New-PnPList -Title $configListName -Template GenericList -EnableVersioning

    # Add columns
    Add-PnPField -List $configListName -DisplayName "Xero Contact ID" -InternalName "XeroContactID" -Type Text -Required
    Add-PnPField -List $configListName -DisplayName "Contact Name" -InternalName "ContactName" -Type Text -Required
    Add-PnPField -List $configListName -DisplayName "Annual Interest Rate (%)" -InternalName "AnnualRate" -Type Number -Required
    Add-PnPField -List $configListName -DisplayName "Minimum Days Overdue" -InternalName "MinDaysOverdue" -Type Number -Required
    Add-PnPField -List $configListName -DisplayName "Minimum Charge Amount" -InternalName "MinChargeAmount" -Type Currency -Required
    Add-PnPField -List $configListName -DisplayName "Currency" -InternalName "CurrencyCode" -Type Choice -Choices "USD","CAD"
    Add-PnPField -List $configListName -DisplayName "Active" -InternalName "IsActive" -Type Boolean
    Add-PnPField -List $configListName -DisplayName "Last Run Date" -InternalName "LastRunDate" -Type DateTime
    Add-PnPField -List $configListName -DisplayName "Last Interest Invoice ID" -InternalName "LastInvoiceID" -Type Text
    Add-PnPField -List $configListName -DisplayName "Notes" -InternalName "Notes" -Type Note

    Write-Host "  Created $configListName" -ForegroundColor Green
}

# ============================================
# InterestLedger List
# ============================================
$ledgerListName = "InterestLedger"

$existingLedgerList = Get-PnPList -Identity $ledgerListName -ErrorAction SilentlyContinue

if ($existingLedgerList) {
    Write-Host "List '$ledgerListName' already exists. Skipping creation." -ForegroundColor Yellow
} else {
    Write-Host "Creating list '$ledgerListName'..." -ForegroundColor Green

    New-PnPList -Title $ledgerListName -Template GenericList -EnableVersioning

    # Add columns
    Add-PnPField -List $ledgerListName -DisplayName "Source Invoice ID" -InternalName "SourceInvoiceId" -Type Text -Required
    Add-PnPField -List $ledgerListName -DisplayName "Source Invoice Number" -InternalName "SourceInvoiceNumber" -Type Text -Required
    Add-PnPField -List $ledgerListName -DisplayName "Interest Invoice ID" -InternalName "InterestInvoiceId" -Type Text -Required
    Add-PnPField -List $ledgerListName -DisplayName "Interest Invoice Number" -InternalName "InterestInvoiceNumber" -Type Text
    Add-PnPField -List $ledgerListName -DisplayName "Period Start" -InternalName "PeriodStart" -Type DateTime -Required
    Add-PnPField -List $ledgerListName -DisplayName "Period End" -InternalName "PeriodEnd" -Type DateTime -Required
    Add-PnPField -List $ledgerListName -DisplayName "Principal Amount" -InternalName "Principal" -Type Currency -Required
    Add-PnPField -List $ledgerListName -DisplayName "Days Charged" -InternalName "DaysCharged" -Type Number -Required
    Add-PnPField -List $ledgerListName -DisplayName "Interest Rate" -InternalName "Rate" -Type Number -Required
    Add-PnPField -List $ledgerListName -DisplayName "Interest Amount" -InternalName "InterestAmount" -Type Currency -Required
    Add-PnPField -List $ledgerListName -DisplayName "Status" -InternalName "Status" -Type Choice -Choices "Active","Credited","Voided" -Required
    Add-PnPField -List $ledgerListName -DisplayName "Credit Note ID" -InternalName "CreditNoteId" -Type Text
    Add-PnPField -List $ledgerListName -DisplayName "Contact ID" -InternalName "ContactId" -Type Text -Required
    Add-PnPField -List $ledgerListName -DisplayName "Contact Name" -InternalName "ContactName" -Type Text -Required
    Add-PnPField -List $ledgerListName -DisplayName "Notes" -InternalName "Notes" -Type Note

    Write-Host "  Created $ledgerListName" -ForegroundColor Green
}

# ============================================
# Add Initial Data (WMA)
# ============================================
Write-Host ""
Write-Host "Adding initial configuration for Waltzing Matilda Aviation..." -ForegroundColor Green

# Check if WMA already exists
$existingWMA = Get-PnPListItem -List $configListName -Query "<View><Query><Where><Eq><FieldRef Name='ContactName'/><Value Type='Text'>Waltzing Matilda Aviation (WMA)</Value></Eq></Where></Query></View>" -ErrorAction SilentlyContinue

if ($existingWMA) {
    Write-Host "  WMA configuration already exists. Skipping." -ForegroundColor Yellow
} else {
    # You'll need to get the actual WMA ContactID from Xero
    # This is a placeholder - replace with actual ID
    Add-PnPListItem -List $configListName -Values @{
        "Title" = "Waltzing Matilda Aviation (WMA)"
        "XeroContactID" = "REPLACE_WITH_ACTUAL_XERO_CONTACT_ID"
        "ContactName" = "Waltzing Matilda Aviation (WMA)"
        "AnnualRate" = 24
        "MinDaysOverdue" = 30
        "MinChargeAmount" = 1.00
        "IsActive" = $true
        "Notes" = "24% annual rate per Paidnice config. Migrated from Paidnice."
    }
    Write-Host "  Added WMA configuration (update XeroContactID!)" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Provisioning Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Lists created at: $SiteUrl" -ForegroundColor White
Write-Host "  - InterestConfig: Client interest rate configurations"
Write-Host "  - InterestLedger: Audit trail of all interest charges"
Write-Host ""
Write-Host "IMPORTANT: Update the WMA XeroContactID with the actual value from Xero!" -ForegroundColor Yellow
Write-Host ""

Disconnect-PnPOnline

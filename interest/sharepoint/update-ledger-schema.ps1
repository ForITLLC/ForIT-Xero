# Update InterestLedger SharePoint List for Reconciliation Schema
# Run with: pwsh update-ledger-schema.ps1

param(
    [string]$SiteUrl = "https://foritllc.sharepoint.com/finance/billing"
)

Write-Host "=== Updating InterestLedger Schema ===" -ForegroundColor Cyan

Connect-PnPOnline -Url $SiteUrl -DeviceLogin

$ledgerListName = "InterestLedger"

# Add new columns for reconciliation tracking
Write-Host "Adding new columns..." -ForegroundColor Yellow

# Action column
$existingAction = Get-PnPField -List $ledgerListName -Identity "Action" -ErrorAction SilentlyContinue
if (-not $existingAction) {
    Add-PnPField -List $ledgerListName -DisplayName "Action" -InternalName "Action" -Type Choice -Choices "Created","Updated","Credited","AdditionalCharge" -Required
    Write-Host "  Added: Action" -ForegroundColor Green
}

# Previous Amount
$existingPrev = Get-PnPField -List $ledgerListName -Identity "PreviousAmount" -ErrorAction SilentlyContinue
if (-not $existingPrev) {
    Add-PnPField -List $ledgerListName -DisplayName "Previous Amount" -InternalName "PreviousAmount" -Type Currency
    Write-Host "  Added: Previous Amount" -ForegroundColor Green
}

# New Amount
$existingNew = Get-PnPField -List $ledgerListName -Identity "NewAmount" -ErrorAction SilentlyContinue
if (-not $existingNew) {
    Add-PnPField -List $ledgerListName -DisplayName "New Amount" -InternalName "NewAmount" -Type Currency
    Write-Host "  Added: New Amount" -ForegroundColor Green
}

# Delta
$existingDelta = Get-PnPField -List $ledgerListName -Identity "Delta" -ErrorAction SilentlyContinue
if (-not $existingDelta) {
    Add-PnPField -List $ledgerListName -DisplayName "Delta" -InternalName "Delta" -Type Currency
    Write-Host "  Added: Delta" -ForegroundColor Green
}

# Reason
$existingReason = Get-PnPField -List $ledgerListName -Identity "Reason" -ErrorAction SilentlyContinue
if (-not $existingReason) {
    Add-PnPField -List $ledgerListName -DisplayName "Reason" -InternalName "Reason" -Type Choice -Choices "Initial","DueDateChanged","PartialPayment","SourceVoided","PrincipalChanged","DailyAccrual","ManualAdjustment"
    Write-Host "  Added: Reason" -ForegroundColor Green
}

# Source Due Date
$existingSDD = Get-PnPField -List $ledgerListName -Identity "SourceDueDate" -ErrorAction SilentlyContinue
if (-not $existingSDD) {
    Add-PnPField -List $ledgerListName -DisplayName "Source Due Date" -InternalName "SourceDueDate" -Type DateTime
    Write-Host "  Added: Source Due Date" -ForegroundColor Green
}

# Source Amount Due
$existingSAD = Get-PnPField -List $ledgerListName -Identity "SourceAmountDue" -ErrorAction SilentlyContinue
if (-not $existingSAD) {
    Add-PnPField -List $ledgerListName -DisplayName "Source Amount Due" -InternalName "SourceAmountDue" -Type Currency
    Write-Host "  Added: Source Amount Due" -ForegroundColor Green
}

# Days Overdue
$existingDO = Get-PnPField -List $ledgerListName -Identity "DaysOverdue" -ErrorAction SilentlyContinue
if (-not $existingDO) {
    Add-PnPField -List $ledgerListName -DisplayName "Days Overdue" -InternalName "DaysOverdue" -Type Number
    Write-Host "  Added: Days Overdue" -ForegroundColor Green
}

# Credit Note Number
$existingCNN = Get-PnPField -List $ledgerListName -Identity "CreditNoteNumber" -ErrorAction SilentlyContinue
if (-not $existingCNN) {
    Add-PnPField -List $ledgerListName -DisplayName "Credit Note Number" -InternalName "CreditNoteNumber" -Type Text
    Write-Host "  Added: Credit Note Number" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Schema Update Complete ===" -ForegroundColor Cyan

Disconnect-PnPOnline

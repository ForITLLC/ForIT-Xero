# Provision InterestConfig SharePoint List
# Run with: pwsh provision-list.ps1
# Requires: PnP.PowerShell module

param(
    [string]$SiteUrl = "https://foritllc.sharepoint.com/finance"
)

# Connect to SharePoint (will prompt for auth)
Connect-PnPOnline -Url $SiteUrl -Interactive

$listName = "InterestConfig"

# Check if list exists
$existingList = Get-PnPList -Identity $listName -ErrorAction SilentlyContinue

if ($existingList) {
    Write-Host "List '$listName' already exists. Skipping creation." -ForegroundColor Yellow
} else {
    Write-Host "Creating list '$listName'..." -ForegroundColor Green

    # Create the list
    New-PnPList -Title $listName -Template GenericList -EnableVersioning

    # Add columns
    Add-PnPField -List $listName -DisplayName "Xero Contact ID" -InternalName "XeroContactID" -Type Text -Required
    Add-PnPField -List $listName -DisplayName "Contact Name" -InternalName "ContactName" -Type Text -Required
    Add-PnPField -List $listName -DisplayName "Annual Interest Rate (%)" -InternalName "AnnualRate" -Type Number -Required
    Add-PnPField -List $listName -DisplayName "Minimum Days Overdue" -InternalName "MinDaysOverdue" -Type Number -Required
    Add-PnPField -List $listName -DisplayName "Minimum Charge Amount" -InternalName "MinChargeAmount" -Type Currency -Required
    Add-PnPField -List $listName -DisplayName "Currency" -InternalName "CurrencyCode" -Type Choice -Choices "USD","CAD"
    Add-PnPField -List $listName -DisplayName "Active" -InternalName "IsActive" -Type Boolean
    Add-PnPField -List $listName -DisplayName "Last Run Date" -InternalName "LastRunDate" -Type DateTime
    Add-PnPField -List $listName -DisplayName "Last Interest Invoice ID" -InternalName "LastInvoiceID" -Type Text
    Add-PnPField -List $listName -DisplayName "Notes" -InternalName "Notes" -Type Note

    Write-Host "List created successfully!" -ForegroundColor Green
}

# Add initial data (Pivot Airlines)
Write-Host "Adding Pivot Airlines configuration..." -ForegroundColor Green

Add-PnPListItem -List $listName -Values @{
    "Title" = "Pivot Airlines"
    "XeroContactID" = "99bcdc23-e430-4c87-aa36-439032a989f2"
    "ContactName" = "Pivot Airlines"
    "AnnualRate" = 18
    "MinDaysOverdue" = 30
    "MinChargeAmount" = 1.00
    "IsActive" = $true
    "Notes" = "Primary client - 18% annual rate per agreement"
}

Write-Host "Done! List is ready at: $SiteUrl/Lists/$listName" -ForegroundColor Green

Disconnect-PnPOnline

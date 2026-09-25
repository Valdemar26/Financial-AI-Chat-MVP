"""
Small FastAPI service that analyzes a bank transaction CSV export.

Expected CSV columns: date, description, amount
  - amount is negative for spending, positive for income
    (this is the standard convention for most bank exports)

Run locally with:
    uvicorn main:app --reload
"""

from io import StringIO

import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile

app = FastAPI(title="Transaction Analysis Service")

# --- Category keyword map -------------------------------------------------
# Very simple keyword-based categorization: we lowercase the transaction
# description and check whether any keyword for a category appears in it.
# The first category with a match wins. Anything unmatched falls into
# "Other". This is intentionally basic — a real system would use a
# trained classifier or a merchant-lookup service.
CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "Groceries": ["grocery", "supermarket", "walmart", "kroger", "whole foods", "trader joe"],
    "Dining": ["restaurant", "cafe", "coffee", "starbucks", "mcdonald", "doordash", "uber eats"],
    "Transport": ["uber", "lyft", "gas station", "shell", "chevron", "transit", "parking"],
    "Utilities": ["electric", "water bill", "internet", "phone bill", "utility", "comcast", "verizon"],
    "Entertainment": ["netflix", "spotify", "movie", "cinema", "hulu", "disney+", "steam"],
    "Rent/Mortgage": ["rent", "mortgage", "landlord"],
    "Shopping": ["amazon", "target", "ebay", "mall", "best buy"],
    "Healthcare": ["pharmacy", "clinic", "doctor", "hospital", "cvs", "walgreens"],
}


def categorize(description: str) -> str:
    """Return the first matching category for a transaction description, or 'Other'."""
    text = description.lower()
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(keyword in text for keyword in keywords):
            return category
    return "Other"


def load_transactions(raw_bytes: bytes) -> pd.DataFrame:
    """Parse the uploaded CSV bytes into a validated, typed DataFrame."""
    try:
        df = pd.read_csv(StringIO(raw_bytes.decode("utf-8")))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV: {exc}") from exc

    required_columns = {"date", "description", "amount"}
    missing = required_columns - set(df.columns)
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"CSV is missing required columns: {sorted(missing)}",
        )

    # Coerce types so downstream math/grouping is safe even if the CSV
    # has stray whitespace, string amounts, etc.
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce")
    df = df.dropna(subset=["date", "amount"])

    if df.empty:
        raise HTTPException(status_code=400, detail="No valid transaction rows found in CSV.")

    return df


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)) -> dict:
    """Accept a transaction CSV and return spending/income summary stats."""
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please upload a .csv file.")

    raw_bytes = await file.read()
    df = load_transactions(raw_bytes)

    # Split into spending (negative amounts) and income (positive amounts).
    spending = df[df["amount"] < 0].copy()
    income = df[df["amount"] > 0]

    total_spent = round(-spending["amount"].sum(), 2)  # store as a positive number
    total_income = round(income["amount"].sum(), 2)

    # Categorize each spending row, then sum by category and take the top 5.
    spending["category"] = spending["description"].astype(str).apply(categorize)
    top_categories = (
        spending.groupby("category")["amount"]
        .sum()
        .abs()
        .sort_values(ascending=False)
        .head(5)
        .round(2)
    )

    # Monthly totals: net amount (income - spending) grouped by calendar month.
    monthly = (
        df.set_index("date")["amount"]
        .resample("MS")  # "MS" = month start, groups by calendar month
        .sum()
        .round(2)
    )

    return {
        "total_spent": total_spent,
        "total_income": total_income,
        "top_spending_categories": [
            {"category": category, "amount": amount}
            for category, amount in top_categories.items()
        ],
        "monthly_totals": [
            {"month": month.strftime("%Y-%m"), "net_amount": amount}
            for month, amount in monthly.items()
        ],
    }

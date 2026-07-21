"""Convert an HTML file to PDF using Playwright (headless Chromium)."""
import sys
from playwright.sync_api import sync_playwright

def main():
    html_path = sys.argv[1]
    pdf_path = sys.argv[2]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(f'file:///{html_path.replace(chr(92), "/")}', wait_until='networkidle')
        page.pdf(path=pdf_path, format='A4', margin={'top': '18mm', 'right': '15mm', 'bottom': '20mm', 'left': '15mm'}, print_background=True)
        browser.close()

if __name__ == '__main__':
    main()

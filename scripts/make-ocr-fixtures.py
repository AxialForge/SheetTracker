#!/usr/bin/env python3
"""Draws an invented, filled-in Form 10899 (2500T) setup sheet for the OCR tests.
All values are made up. Outputs: sheet-10899.png (clean scan), sheet-10899-photo.jpg (skewed, noisy),
sheet-10899-scan.pdf (image-only PDF) and sheet-10899-text.pdf (PDF with a text layer).
Run: python3 scripts/make-ocr-fixtures.py"""
import os, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fixtures', 'ocr')
W, H = 1700, 2200
REG = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
BLD = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
font = lambda p, s: ImageFont.truetype(p, s)

# (x, y, text, bold) in page pixels. The same list drives the PNG and the text PDF.
T = []
def t(x, y, s, bold=False, size=26): T.append((x, y, s, bold, size))

t(60, 50, 'PRESS LINE:', True); t(260, 50, '9')
t(340, 50, 'PART NO.:', True); t(500, 50, '40-7731-02')
t(760, 50, 'REVISION:', True); t(920, 50, 'B2')
t(1000, 50, 'DESIGN BY/DATE:', True); t(1250, 50, 'MAP 03/14/2024')
t(60, 100, 'REVISED BY/ DATE:', True); t(330, 100, 'JRK 09/22/2026')
t(700, 100, 'HMI FILE #:', True); t(870, 100, '47')

# left column
t(60, 200, 'STATION# 1:', True); t(260, 200, 'EMPTY')
t(60, 330, 'TONNAGE:', True); t(220, 330, '850 T')
t(60, 380, 'LEAVE TONGS IN', True); t(330, 380, 'YES')
t(60, 480, 'STATION# 2:', True); t(260, 480, 'PREFORM')
t(60, 610, 'TONNAGE:', True); t(220, 610, '1400 T')
t(60, 720, 'STATION# 3:', True); t(260, 720, 'FINISH')
t(60, 850, 'TONNAGE:', True); t(220, 850, '1180 T')
t(60, 1000, 'SPECIAL FORGE INSTRUCTION', True); t(60, 1040, 'RUN HOT, WATCH FLASH')
t(60, 1600, 'SPECIAL TRIM INSTRUCTION', True); t(60, 1640, 'TRIM FROM TOP')

# right column
X = 780
rows = [
  ('H', 'BILLET HEATING REQUIREMENTS'),
  ('NUMBER OF COILS', '3'),
  ('BILLET TEMPERATURE', '2275', '°F'),
  ('LOW REJECT TEMPERATURE', '2200', '°F'),
  ('HI REJECT TEMPERATURE', '2400', '°F'),
  ('SCRAP TEMPERATURE', '2425', '°F'),
  ('BILLET DIAMETER', '2.375', '"'),
  ('BILLET LENGTH', '3.944', '"'),
  ('BILLET WEIGHT', '4.95', 'LB'),
  ("BILLET GRADE MAT'L", '1045 STEEL'),
  ('COIL NUMBER', '25Z3'),
  ('% OF COIL AMPS', ''),
  ('COIL# 1:', '46.5'),
  ('COIL# 2:', '54.5'),
  ('COIL# 3:', '61.0'),
  ('CYCLE TIME', '12', 'secs'),
  ('H', 'FORGE PRESS REQUIREMENTS'),
  ('WEDGE', '0.125'),
  ('DIE STATIONS', '3'),
  ('KICK SETUP', 'DIE POSITION    KO#    DWELL'),
  ('HIT# 1', '1        1        0.50'),
  ('HIT# 2', '2        2        0.75'),
  ('HIT# 3', '3        3        1.00'),
  ('H', 'DIE LUBE REQUIREMENTS'),
  ('LUBE TYPE', 'CONDAT ORAFOR 630'),
  ('LUBE CONCENTRATION', '2100'),
  ('LUBE PROGRAM', '14'),
  ('LUBE HEAD NUMBER', 'LARGE CONE'),
  ('H', 'BILLET SPACERS REQUIREMENTS'),
  ('SPACER DIAMETER', '2.500', '"'),
  ('NUMBER OF SPACERS', '5'),
  ('H', 'PICK AND PLACE ROBOT SETTINGS'),
  ('ROBOT HEAD NUMBER', '2'),
  ('COOL DOWN', '8', 'secs'),
  ('DROP POSITION', '3'),
  ('Z OFFSET', '0.040'),
  ('H', 'TRIM PRESS REQUIREMENTS'),
  ('SHUT HEIGHT', '16.250', '"'),
  ('NITROGEN', '500', 'PSI'),
  ('PART COOLING REQUIREMENT', 'FANS ON'),
  ('', '1 SLOW CONVEYOR'),
  ('', 'HOT BOX'),
  ('SCRAP DISPOSAL', 'CARBON'),
]
y = 175
for r in rows:
    if r[0] == 'H':
        t(X, y, r[1], True, 28); y += 46; continue
    if r[0]: t(X, y, r[0], r[0] != '' and not r[0].startswith('COIL#') and not r[0].startswith('HIT#'))
    vx = X + 410 if not (r[0].startswith('COIL#') or r[0].startswith('HIT#') or r[0] == 'KICK SETUP') else X + 150
    if r[0] == '': vx = X + 410
    if r[0].startswith('HIT#') or r[0] == 'KICK SETUP': vx = X + 150
    t(vx, y, r[1])
    if len(r) > 2: t(vx + 190, y, r[2])
    y += 40
t(60, 2122, 'FORM#: 10899', True, 22); t(480, 2122, 'REVISION: A', True, 22); t(860, 2122, 'ECN: 11583', True, 22); t(1200, 2122, 'DATE: 04/25/2023', True, 22)

def page():
    im = Image.new('L', (W, H), 255)
    d = ImageDraw.Draw(im)
    for x, y, s, b, size in T:
        d.text((x, y), s, fill=0, font=font(BLD if b else REG, size))
    d.rectangle([40, 30, W - 40, H - 40], outline=0, width=3)
    d.line([(40, 160), (W - 40, 160)], fill=0, width=2)
    d.line([(740, 160), (740, H - 40)], fill=0, width=2)
    d.line([(40, 2110), (W - 40, 2110)], fill=0, width=2)
    return im

clean = page()
clean.save(os.path.join(OUT, 'sheet-10899.png'), optimize=True)

random.seed(7)
ph = clean.rotate(1.6, resample=Image.BICUBIC, fillcolor=235).filter(ImageFilter.GaussianBlur(1.1))
px = ph.load()
for _ in range(60000):
    x, y = random.randrange(W), random.randrange(H)
    px[x, y] = max(0, min(255, px[x, y] + random.randint(-40, 40)))
ph = ph.point(lambda v: int(60 + v * 0.72))     # low contrast, grey paper
ph.save(os.path.join(OUT, 'sheet-10899-photo.jpg'), quality=70)

clean.convert('RGB').save(os.path.join(OUT, 'sheet-10899-scan.pdf'), resolution=200)

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
c = canvas.Canvas(os.path.join(OUT, 'sheet-10899-text.pdf'), pagesize=letter)
k = 72 / 200.0
for x, y, s, b, size in T:
    c.setFont('Helvetica-Bold' if b else 'Helvetica', size * k * 0.95)
    c.drawString(x * k, letter[1] - (y + size) * k, s.replace('°', '°'))
c.save()
print('ok')

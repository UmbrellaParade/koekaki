# Generates the PWA icons with System.Drawing so the build needs no extra dependency.
# ASCII only on purpose: Windows PowerShell reads .ps1 as ANSI when the file has no BOM,
# and non-ASCII comments get mangled into parse errors.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1
Add-Type -AssemblyName System.Drawing

$outDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\public\icons'))
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

function New-Icon {
    param(
        [int]$Size,
        # 0 means square corners (used for the maskable icon)
        [double]$CornerRatio,
        # Glyph scale in a 100-unit layout space; maskable needs a smaller safe area
        [double]$GlyphScale
    )

    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $rect = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $Size, $Size
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList `
        $rect,
        ([System.Drawing.ColorTranslator]::FromHtml('#7C6CFF')),
        ([System.Drawing.ColorTranslator]::FromHtml('#4AC7FF')),
        45.0

    if ($CornerRatio -gt 0) {
        $d = [int]($Size * $CornerRatio) * 2
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc(0, 0, $d, $d, 180, 90)
        $path.AddArc($Size - $d, 0, $d, $d, 270, 90)
        $path.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
        $path.AddArc(0, $Size - $d, $d, $d, 90, 90)
        $path.CloseFigure()
        $g.FillPath($brush, $path)
        $path.Dispose()
    }
    else {
        $g.FillRectangle($brush, $rect)
    }

    # --- microphone glyph ---
    $cx = $Size / 2.0
    $cy = $Size / 2.0
    $s = $Size * $GlyphScale / 100.0 / 100.0

    $white = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::White)
    $pen = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::White), ([float]($s * 8))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    # capsule body
    $capW = $s * 30
    $capH = $s * 56
    $capX = $cx - $capW / 2
    $capY = $cy - $s * 48
    $cap = New-Object System.Drawing.Drawing2D.GraphicsPath
    $cap.AddArc([float]$capX, [float]$capY, [float]$capW, [float]$capW, 180, 180)
    $cap.AddArc([float]$capX, [float]($capY + $capH - $capW), [float]$capW, [float]$capW, 0, 180)
    $cap.CloseFigure()
    $g.FillPath($white, $cap)
    $cap.Dispose()

    # cradle arc
    $arc = $s * 64
    $g.DrawArc($pen, [float]($cx - $arc / 2), [float]($cy - $arc / 2 - $s * 6), [float]$arc, [float]$arc, 10, 160)

    # stand
    $g.DrawLine($pen, [float]$cx, [float]($cy + $arc / 2 - $s * 6), [float]$cx, [float]($cy + $s * 46))

    $pen.Dispose()
    $white.Dispose()
    $brush.Dispose()
    $g.Dispose()
    return $bmp
}

$targets = @(
    @{ File = 'icon-512.png'; Size = 512; Corner = 0.22; Glyph = 100 },
    @{ File = 'icon-192.png'; Size = 192; Corner = 0.22; Glyph = 100 },
    @{ File = 'icon-maskable-512.png'; Size = 512; Corner = 0.0; Glyph = 70 },
    @{ File = 'apple-touch-icon.png'; Size = 180; Corner = 0.0; Glyph = 86 }
)

foreach ($t in $targets) {
    $bmp = New-Icon -Size $t.Size -CornerRatio $t.Corner -GlyphScale $t.Glyph
    $path = Join-Path $outDir $t.File
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "generated: $path"
}

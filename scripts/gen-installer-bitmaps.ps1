Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $projectRoot "build"
if (!(Test-Path $buildDir)) {
    New-Item -ItemType Directory -Path $buildDir | Out-Null
}

function Create-InstallerSidebar {
    param([string]$outPath)
    $w = 164
    $h = 314
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Dark background gradient
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
        (New-Object System.Drawing.Point 0, 0),
        (New-Object System.Drawing.Point 0, $h),
        ([System.Drawing.Color]::FromArgb(255, 10, 12, 16)),
        ([System.Drawing.Color]::FromArgb(255, 20, 23, 31))
    )
    $g.FillRectangle($bgBrush, 0, 0, $w, $h)
    $bgBrush.Dispose()

    # Ambient glow behind badge
    $glowRect = New-Object System.Drawing.Rectangle 22, 35, 120, 120
    $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $glowPath.AddEllipse($glowRect)
    $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush $glowPath
    $glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(45, 208, 188, 255)
    $glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 10, 12, 16))
    $g.FillEllipse($glowBrush, $glowRect)
    $glowBrush.Dispose()
    $glowPath.Dispose()

    # ViewFlux squircle badge
    $badgeSize = 64
    $badgeX = [int](($w - $badgeSize) / 2)
    $badgeY = 62
    $r = 22

    # Rounded rectangle path
    $badgePath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $badgePath.AddArc($badgeX, $badgeY, $r*2, $r*2, 180, 90)
    $badgePath.AddArc($badgeX + $badgeSize - $r*2, $badgeY, $r*2, $r*2, 270, 90)
    $badgePath.AddArc($badgeX + $badgeSize - $r*2, $badgeY + $badgeSize - $r*2, $r*2, $r*2, 0, 90)
    $badgePath.AddArc($badgeX, $badgeY + $badgeSize - $r*2, $r*2, $r*2, 90, 90)
    $badgePath.CloseFigure()

    # Diagonal gradient for badge: #d0bcff to #4f378b
    $badgeBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
        (New-Object System.Drawing.Point $badgeX, $badgeY),
        (New-Object System.Drawing.Point ($badgeX + $badgeSize), ($badgeY + $badgeSize)),
        ([System.Drawing.Color]::FromArgb(255, 208, 188, 255)),
        ([System.Drawing.Color]::FromArgb(255, 79, 55, 139))
    )
    $g.FillPath($badgeBrush, $badgePath)
    $badgeBrush.Dispose()

    # Play Triangle inside badge: #381e72
    $triH = $badgeSize * 0.40
    $triW = $triH * (11 / 14)
    $cx = $badgeX + $badgeSize / 2
    $cy = $badgeY + $badgeSize / 2
    $baseX = $cx - $triW * (4 / 11)
    $tipX = $baseX + $triW
    $topY = $cy - $triH / 2
    $botY = $cy + $triH / 2

    $triPoints = @(
        (New-Object System.Drawing.PointF $baseX, $topY),
        (New-Object System.Drawing.PointF $baseX, $botY),
        (New-Object System.Drawing.PointF $tipX, $cy)
    )
    $triBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 56, 30, 114))
    $g.FillPolygon($triBrush, $triPoints)
    $triBrush.Dispose()
    $badgePath.Dispose()

    # Title "ViewFlux"
    $fontTitle = New-Object System.Drawing.Font ("Segoe UI", [float]16, [System.Drawing.FontStyle]::Bold)
    $titleBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 241, 243, 247))
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString("ViewFlux", $fontTitle, $titleBrush, [float]($w / 2), [float]140, $sf)
    $fontTitle.Dispose()
    $titleBrush.Dispose()

    # Subtitle "DESKTOP"
    $fontSub = New-Object System.Drawing.Font ("Segoe UI", [float]8, [System.Drawing.FontStyle]::Bold)
    $subBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 208, 188, 255))
    $g.DrawString("D E S K T O P", $fontSub, $subBrush, [float]($w / 2), [float]168, $sf)
    $fontSub.Dispose()
    $subBrush.Dispose()

    # Decorative accent line
    $lineBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
        (New-Object System.Drawing.Point 42, 192),
        (New-Object System.Drawing.Point 122, 192),
        ([System.Drawing.Color]::FromArgb(0, 208, 188, 255)),
        ([System.Drawing.Color]::FromArgb(180, 208, 188, 255))
    )
    $lineBrush.WrapMode = [System.Drawing.Drawing2D.WrapMode]::TileFlipX
    $linePen = New-Object System.Drawing.Pen ($lineBrush, [float]1.5)
    $g.DrawLine($linePen, [float]42, [float]192, [float]122, [float]192)
    $linePen.Dispose()
    $lineBrush.Dispose()

    # Tagline at bottom
    $fontTag = New-Object System.Drawing.Font ("Segoe UI", [float]8, [System.Drawing.FontStyle]::Regular)
    $tagBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 130, 142, 159))
    $g.DrawString("Fast YouTube Client", $fontTag, $tagBrush, [float]($w / 2), [float]278, $sf)
    $fontTag.Dispose()
    $tagBrush.Dispose()
    $sf.Dispose()

    # Save as 24-bit BMP
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "Created $outPath successfully"
}

function Create-InstallerHeader {
    param([string]$outPath)
    $w = 150
    $h = 57
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # White background matching MUI2 header banner
    $g.Clear([System.Drawing.Color]::FromArgb(255, 255, 255, 255))

    # Badge on the right
    $badgeSize = 38
    $badgeX = 100
    $badgeY = [int](($h - $badgeSize) / 2)
    $r = 13

    # Rounded rectangle path
    $badgePath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $badgePath.AddArc($badgeX, $badgeY, $r*2, $r*2, 180, 90)
    $badgePath.AddArc($badgeX + $badgeSize - $r*2, $badgeY, $r*2, $r*2, 270, 90)
    $badgePath.AddArc($badgeX + $badgeSize - $r*2, $badgeY + $badgeSize - $r*2, $r*2, $r*2, 0, 90)
    $badgePath.AddArc($badgeX, $badgeY + $badgeSize - $r*2, $r*2, $r*2, 90, 90)
    $badgePath.CloseFigure()

    $badgeBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
        (New-Object System.Drawing.Point $badgeX, $badgeY),
        (New-Object System.Drawing.Point ($badgeX + $badgeSize), ($badgeY + $badgeSize)),
        ([System.Drawing.Color]::FromArgb(255, 208, 188, 255)),
        ([System.Drawing.Color]::FromArgb(255, 79, 55, 139))
    )
    $g.FillPath($badgeBrush, $badgePath)
    $badgeBrush.Dispose()

    # Play triangle
    $triH = $badgeSize * 0.40
    $triW = $triH * (11 / 14)
    $cx = $badgeX + $badgeSize / 2
    $cy = $badgeY + $badgeSize / 2
    $baseX = $cx - $triW * (4 / 11)
    $tipX = $baseX + $triW
    $topY = $cy - $triH / 2
    $botY = $cy + $triH / 2

    $triPoints = @(
        (New-Object System.Drawing.PointF $baseX, $topY),
        (New-Object System.Drawing.PointF $baseX, $botY),
        (New-Object System.Drawing.PointF $tipX, $cy)
    )
    $triBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 56, 30, 114))
    $g.FillPolygon($triBrush, $triPoints)
    $triBrush.Dispose()
    $badgePath.Dispose()

    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "Created $outPath successfully"
}

$sidebarBmp = Join-Path $buildDir "installerSidebar.bmp"
$uninstallerSidebarBmp = Join-Path $buildDir "uninstallerSidebar.bmp"
$headerBmp = Join-Path $buildDir "installerHeader.bmp"

Create-InstallerSidebar $sidebarBmp
Copy-Item $sidebarBmp $uninstallerSidebarBmp
Create-InstallerHeader $headerBmp

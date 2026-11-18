$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$decoderType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$bitmapType = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$engineType = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$resultType = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$languageType = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
$pixelFormat = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$alphaMode = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType=WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and
    $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Read-WinRtResult($Operation, [Type]$Type) {
    $task = $asTask.MakeGenericMethod($Type).Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
}

$engine = $engineType::TryCreateFromLanguage($languageType::new('zh-Hans-CN'))
if (-not $engine) { $engine = $engineType::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'No Windows OCR language is installed.' }

$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$memory = [IO.MemoryStream]::new($bytes)
$stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
$bitmap = $null
try {
    $decoder = Read-WinRtResult ($decoderType::CreateAsync($stream)) $decoderType
    $bitmap = Read-WinRtResult ($decoder.GetSoftwareBitmapAsync($pixelFormat::Bgra8, $alphaMode::Premultiplied)) $bitmapType
    $result = Read-WinRtResult ($engine.RecognizeAsync($bitmap)) $resultType
    $lines = foreach ($line in $result.Lines) {
        $words = foreach ($word in $line.Words) {
            '{0},{1}:{2}' -f [int]$word.BoundingRect.X, [int]$word.BoundingRect.Y, $word.Text
        }
        $words -join ' '
    }
    [Console]::WriteLine($result.Text)
    [Console]::Write(($lines -join "`n"))
} finally {
    if ($bitmap) { $bitmap.Dispose() }
    $stream.Dispose()
    $memory.Dispose()
}

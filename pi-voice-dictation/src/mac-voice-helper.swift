import AVFoundation
import Foundation
import Speech

func printStdout(_ text: String) {
    if let data = (text + "\n").data(using: .utf8) {
        FileHandle.standardOutput.write(data)
    }
}

func printStderr(_ text: String) {
    if let data = (text + "\n").data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

func fail(_ text: String, code: Int32 = 1) -> Never {
    printStderr("ERROR: \(text)")
    exit(code)
}

func requestMicrophoneAccess() -> Bool {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)

    switch status {
    case .authorized:
        return true
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            granted = ok
            semaphore.signal()
        }
        semaphore.wait()
        return granted
    default:
        return false
    }
}

func requestSpeechAccess() -> Bool {
    let status = SFSpeechRecognizer.authorizationStatus()

    switch status {
    case .authorized:
        return true
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        SFSpeechRecognizer.requestAuthorization { nextStatus in
            granted = nextStatus == .authorized
            semaphore.signal()
        }
        semaphore.wait()
        return granted
    default:
        return false
    }
}

func recordAudio(to path: String) {
    guard requestMicrophoneAccess() else {
        fail("Microphone permission was denied. Enable microphone access for your terminal app in System Settings > Privacy & Security > Microphone.")
    }

    let url = URL(fileURLWithPath: path)
    try? FileManager.default.removeItem(at: url)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)

    let settings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
    ]

    let recorder: AVAudioRecorder
    do {
        recorder = try AVAudioRecorder(url: url, settings: settings)
    } catch {
        fail("Failed to create recorder: \(error.localizedDescription)")
    }

    recorder.isMeteringEnabled = false
    guard recorder.prepareToRecord() else {
        fail("Failed to prepare recorder")
    }
    guard recorder.record() else {
        fail("Failed to start recording")
    }

    printStdout("READY")

    // The TypeScript extension closes stdin to stop recording cleanly.
    _ = FileHandle.standardInput.readDataToEndOfFile()
    recorder.stop()

    printStdout("SAVED \(path)")
}

func transcribeAudio(at path: String, localeIdentifier: String?) {
    guard requestSpeechAccess() else {
        fail("Speech Recognition permission was denied. Enable speech recognition for your terminal app in System Settings > Privacy & Security > Speech Recognition.")
    }

    let locale = Locale(identifier: localeIdentifier ?? Locale.current.identifier)
    guard let recognizer = SFSpeechRecognizer(locale: locale) else {
        fail("Speech recognizer is unavailable for locale \(locale.identifier)")
    }
    guard recognizer.isAvailable else {
        fail("Speech recognizer is currently unavailable for locale \(locale.identifier)")
    }

    let url = URL(fileURLWithPath: path)
    let request = SFSpeechURLRecognitionRequest(url: url)
    request.shouldReportPartialResults = false

    var done = false
    var transcript = ""
    var failure: Error?

    let task = recognizer.recognitionTask(with: request) { result, error in
        if let result = result {
            transcript = result.bestTranscription.formattedString
            if result.isFinal {
                done = true
            }
        }

        if let error = error {
            failure = error
            done = true
        }
    }

    let deadline = Date().addingTimeInterval(120)
    while !done && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
    }

    if !done {
        task.cancel()
        fail("Timed out while transcribing audio with Apple Speech")
    }

    if transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let failure = failure {
        fail("Apple Speech transcription failed: \(failure.localizedDescription)")
    }

    printStdout(transcript)
}

let args = CommandLine.arguments
if args.count < 3 {
    fail("Usage: mac-voice-helper record <output.m4a> | transcribe <input.m4a> [locale]")
}

let command = args[1]
let path = args[2]

switch command {
case "record":
    recordAudio(to: path)
case "transcribe":
    transcribeAudio(at: path, localeIdentifier: args.count >= 4 ? args[3] : nil)
default:
    fail("Unknown command: \(command)")
}

import { UUID } from "@opendaw/lib-std";
import { PPQN } from "@opendaw/lib-dsp";
import { Project } from "@opendaw/studio-core";
import { AudioFileBox, AudioRegionBox, ValueEventCollectionBox } from "@opendaw/studio-boxes";
import { InstrumentFactories } from "@opendaw/studio-adapters";
import { loadAudioFile } from "./audioUtils";
import { setLoopEndFromTracks } from "./projectSetup";
import type { TrackData, TrackFileConfig } from "./types";

interface TrackLoadingOptions {
  defaultVolume?: number;
  autoSetLoopEnd?: boolean;
  onProgress?: (current: number, total: number, trackName: string) => void;
}

export function createTrackFromAudioBuffer(
  project: Project,
  sampleName: string,
  audioBuffer: AudioBuffer,
  audioBuffers: Map<string, AudioBuffer>,
  options?: { defaultVolume?: number }
): TrackData {
  const { defaultVolume = 0 } = options || {};
  const bpm = project.timelineBox.bpm.getValue();
  const boxGraph = project.boxGraph;
  const fileUUID = UUID.generate();
  const uuidString = UUID.toString(fileUUID);

  audioBuffers.set(uuidString, audioBuffer);

  let createdTrack: TrackData | null = null;
  project.editing.modify(() => {
    const { audioUnitBox, trackBox } = project.api.createInstrument(InstrumentFactories.Tape);
    audioUnitBox.volume.setValue(defaultVolume);

    const audioFileBox = AudioFileBox.create(boxGraph, fileUUID, box => {
      box.fileName.setValue(sampleName);
      box.endInSeconds.setValue(audioBuffer.duration);
    });

    const clipDurationInPPQN = PPQN.secondsToPulses(audioBuffer.duration, bpm);
    const eventsCollectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate());

    AudioRegionBox.create(boxGraph, UUID.generate(), box => {
      box.regions.refer(trackBox.regions);
      box.file.refer(audioFileBox);
      box.events.refer(eventsCollectionBox.owners);
      box.position.setValue(0);
      box.duration.setValue(clipDurationInPPQN);
      box.loopOffset.setValue(0);
      box.loopDuration.setValue(clipDurationInPPQN);
      box.label.setValue(sampleName);
      box.mute.setValue(false);
    });

    createdTrack = {
      name: sampleName,
      trackBox,
      audioUnitBox,
      uuid: fileUUID
    };
  });

  if (!createdTrack) {
    throw new Error(`Failed to create track for "${sampleName}"`);
  }

  return createdTrack;
}

/**
 * Load audio tracks from files and create them in the OpenDAW project
 *
 * @param project - The OpenDAW project instance
 * @param audioContext - The AudioContext for loading audio files
 * @param files - Array of track configurations (name and file path)
 * @param audioBuffers - Map to store loaded AudioBuffer instances
 * @param options - Optional configuration
 * @returns Promise resolving to array of loaded tracks
 *
 * @example
 * ```typescript
 * const tracks = await loadTracksFromFiles(project, audioContext, [
 *   { name: "Drums", file: "/audio/drums.ogg" },
 *   { name: "Bass", file: "/audio/bass.ogg" }
 * ], audioBuffers);
 * ```
 */
export async function loadTracksFromFiles(
  project: Project,
  audioContext: AudioContext,
  files: TrackFileConfig[],
  audioBuffers: Map<string, AudioBuffer>,
  options?: TrackLoadingOptions
): Promise<TrackData[]> {
  const { defaultVolume = 0, autoSetLoopEnd = true, onProgress } = options || {};
  const bpm = project.timelineBox.bpm.getValue();
  const loadedTracks: TrackData[] = [];
  const failedTracks: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const sample = files[i];

    try {
      onProgress?.(i + 1, files.length, sample.name);
      const audioBuffer = await loadAudioFile(audioContext, sample.file);
      loadedTracks.push(
        createTrackFromAudioBuffer(project, sample.name, audioBuffer, audioBuffers, {
          defaultVolume
        })
      );
    } catch (error) {
      console.error(`Failed to load ${sample.name}:`, error);
      failedTracks.push(sample.name);
    }
  }

  if (failedTracks.length > 0) {
    console.warn(`Failed to load ${failedTracks.length} track(s): ${failedTracks.join(", ")}`);
  }

  // Set loop end to accommodate the longest track
  if (autoSetLoopEnd) {
    setLoopEndFromTracks(project, audioBuffers, bpm);
  }

  console.debug("Tracks created, waiting for samples to load into engine...");

  // Wait for all samples to be loaded into the audio engine before returning
  // This ensures playback can start immediately without waiting
  await project.engine.queryLoadingComplete();

  console.debug("Samples loaded, ready for playback");
  console.debug(`Timeline position: ${project.engine.position.getValue()}`);
  console.debug(`BPM: ${bpm}`);

  // Make sure the timeline is at the beginning
  project.engine.setPosition(0);

  return loadedTracks;
}

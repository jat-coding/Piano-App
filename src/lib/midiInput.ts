/** Web MIDI input — feeds the player's hardware keyboard into wait-mode. */
export interface MidiHandlers {
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
}

export function midiSupported(): boolean {
  return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
}

export class MidiInput {
  private access: any = null;
  private listener: ((e: any) => void) | null = null;
  deviceNames: string[] = [];

  async enable(handlers: MidiHandlers): Promise<string[]> {
    if (!midiSupported()) throw new Error('Web MIDI is not supported in this browser.');
    this.access = await (navigator as any).requestMIDIAccess({ sysex: false });

    this.listener = (e: any) => {
      const [status, note, velocity] = e.data as Uint8Array;
      const command = status & 0xf0;
      if (command === 0x90 && velocity > 0) handlers.onNoteOn(note, velocity / 127);
      else if (command === 0x80 || (command === 0x90 && velocity === 0)) handlers.onNoteOff(note);
    };

    this.attachAll();
    // Re-attach when devices are plugged in/out mid-session.
    this.access.onstatechange = () => this.attachAll();
    return this.deviceNames;
  }

  private attachAll(): void {
    if (!this.access) return;
    this.deviceNames = [];
    this.access.inputs.forEach((input: any) => {
      input.onmidimessage = this.listener;
      if (input.name) this.deviceNames.push(input.name);
    });
  }

  disable(): void {
    if (!this.access) return;
    this.access.inputs.forEach((input: any) => (input.onmidimessage = null));
    this.access.onstatechange = null;
    this.access = null;
    this.deviceNames = [];
  }
}

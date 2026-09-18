package net.nbmachina.mod.score;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * M3-17（P2-2）· 谱面直读：把 `machine_pipeline.csv`（由 `tools/export-mod-score.mjs` 导出成精简版）
 * 读进内存，供 {@link NbmachinaScorePlayer} 按时间派发。
 *
 * <p>为什么要有这一步：以前游戏内的声音靠"数据包 `/playsound` + 资源包"，必须装着资源包、
 * 而且只能是 Ogg；现在服务端直接按谱面把音符发给客户端，客户端用**我们自己的无损引擎**播母版。
 *
 * <p>CSV 口径（导出工具写死，解析按表头取列，不猜列序）：
 * <pre>
 * time_seconds,instrument,midi,velocity,voice[,dur_ms]
 * 0.000,salamander48,75,127,harp,890
 * </pre>
 * 第 6 列 `dur_ms`（M3-22 可选）：这颗音的实际发声时长（键释放 + 踏板，来自参考演奏校准）；
 * 没有这一列就按"采样自然衰减到底"播（旧行为）。
 * `instrument` 必须是 `config/nbmachina/instruments.json` 里的乐器 id；解析不了的行会被计数跳过。
 */
public final class NbmachinaScore {
	/** 一颗音：什么时候、用什么乐器、多高、多重、响多久、来自哪个声部（voice 只用于诊断） */
	public record Note(double timeSec, String instrument, int midi, int velocity, String voice, int durMs) {
	}

	private final Path source;
	private final List<Note> notes;
	private final int totalRows;
	private final int skippedRows;
	private final Map<String, Integer> byVoice;

	private NbmachinaScore(Path source, List<Note> notes, int totalRows, int skippedRows, Map<String, Integer> byVoice) {
		this.source = source;
		this.notes = notes;
		this.totalRows = totalRows;
		this.skippedRows = skippedRows;
		this.byVoice = byVoice;
	}

	public Path source() {
		return source;
	}

	public List<Note> notes() {
		return notes;
	}

	public int size() {
		return notes.size();
	}

	public int totalRows() {
		return totalRows;
	}

	public int skippedRows() {
		return skippedRows;
	}

	public Map<String, Integer> byVoice() {
		return byVoice;
	}

	public double durationSec() {
		return notes.isEmpty() ? 0.0 : notes.get(notes.size() - 1).timeSec();
	}

	/** 读取并解析；行内任何字段非法就跳过（计数），不抛异常打断整个文件 */
	public static NbmachinaScore load(Path file) throws IOException {
		List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
		if (lines.isEmpty()) throw new IOException("空文件：" + file);
		String[] header = lines.get(0).split(",");
		Map<String, Integer> idx = new HashMap<>();
		for (int i = 0; i < header.length; i++) idx.put(header[i].trim(), i);
		for (String need : List.of("time_seconds", "instrument", "midi", "velocity")) {
			if (!idx.containsKey(need)) throw new IOException("谱面缺列 " + need + "：" + String.join(",", header));
		}
		List<Note> notes = new ArrayList<>();
		Map<String, Integer> byVoice = new HashMap<>();
		int total = 0;
		int skipped = 0;
		for (int i = 1; i < lines.size(); i++) {
			String line = lines.get(i).trim();
			if (line.isEmpty()) continue;
			total++;
			String[] c = line.split(",");
			try {
				double t = Double.parseDouble(c[idx.get("time_seconds")]);
				String instrument = c[idx.get("instrument")].trim();
				int midi = Integer.parseInt(c[idx.get("midi")].trim());
				int velocity = Integer.parseInt(c[idx.get("velocity")].trim());
				String voice = idx.containsKey("voice") && c.length > idx.get("voice")
					? c[idx.get("voice")].trim() : "";
				int durMs = 0;
				if (idx.containsKey("dur_ms") && c.length > idx.get("dur_ms")) {
					String d = c[idx.get("dur_ms")].trim();
					if (!d.isEmpty()) durMs = Math.max(0, Math.round(Float.parseFloat(d)));
				}
				if (instrument.isEmpty() || midi < 0 || midi > 127) throw new NumberFormatException("字段越界");
				velocity = Math.max(1, Math.min(127, velocity));
				notes.add(new Note(t, instrument, midi, velocity, voice, durMs));
				byVoice.merge(voice.isEmpty() ? "(未知)" : voice, 1, Integer::sum);
			} catch (RuntimeException e) {
				skipped++;
			}
		}
		notes.sort(Comparator.comparingDouble(Note::timeSec));
		return new NbmachinaScore(file, notes, total, skipped, byVoice);
	}
}

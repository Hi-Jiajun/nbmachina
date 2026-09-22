// Adds the nbmachina "Flashback HDR export" bridge to an HDR mod checkout (M3-82).
// The bridge is deliberately reflection-based: the HDR mod must keep compiling against the
// *published* Flashback (which has no HdrExportBridge), and if the patched Flashback disappears
// (user updates the mod) registration just fails quietly and the HDR mod behaves as before.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('usage: node apply-hdrmod-bridge.mjs <hdr mod checkout>');
const COMMON = join(root, 'common/src/main/java/xyz/rrtt217/HDRMod');
const file = join(COMMON, 'compat/flashback/FlashbackHdrBridge.java');
if (existsSync(file)) throw new Error('bridge already present: ' + file);
mkdirSync(dirname(file), { recursive: true });
const source = [
'package xyz.rrtt217.HDRMod.compat.flashback;',
'',
'import com.mojang.blaze3d.pipeline.RenderTarget;',
'import com.mojang.blaze3d.textures.GpuTexture;',
'import dev.architectury.platform.Platform;',
'import me.shedaniel.autoconfig.AutoConfig;',
'import xyz.rrtt217.HDRMod.api.color.Enums;',
'import xyz.rrtt217.HDRMod.config.HDRModConfig;',
'import xyz.rrtt217.HDRMod.core.color.ColorTransformRenderer;',
'',
'import java.lang.reflect.Proxy;',
'',
'/**',
' * Lets Flashback (patched with HdrExportBridge) export HDR: it hands Flashback a texture that holds',
' * the frame after the HDR colour transform (BT.2020 + PQ), readable as 16-bit normalised RGBA.',
' * Flashback does the row flip and feeds the buffer to its encoder as RGBA64.',
' */',
'public class FlashbackHdrBridge {',
'',
'    private static ColorTransformRenderer renderer;',
'    private static RenderTarget rendererSource;',
'    private static boolean registered;',
'',
'    public static void tryRegister() {',
'        if (!Platform.isModLoaded("flashback")) {',
'            return;',
'        }',
'        try {',
'            Class<?> bridge = Class.forName("com.moulberry.flashback.exporting.HdrExportBridge");',
'            Class<?> colorTransform = Class.forName("com.moulberry.flashback.exporting.HdrExportBridge$ColorTransform");',
'            Object proxy = Proxy.newProxyInstance(FlashbackHdrBridge.class.getClassLoader(), new Class<?>[]{colorTransform},',
'                    (instance, method, args) -> method.getName().equals("transform")',
'                            ? transform((RenderTarget) args[0], (Integer) args[1], (Integer) args[2])',
'                            : null);',
'            bridge.getMethod("register", colorTransform).invoke(null, proxy);',
'            registered = true;',
'            System.out.println("[nbmachina] registered HDR export bridge with Flashback");',
'        } catch (Throwable t) {',
'            System.out.println("[nbmachina] Flashback has no HdrExportBridge (patched jar not installed?) - HDR export stays off");',
'        }',
'    }',
'',
'    public static boolean isRegistered() {',
'        return registered;',
'    }',
'',
'    private static GpuTexture transform(RenderTarget source, int width, int height) {',
'        HDRModConfig config = AutoConfig.getConfigHolder(HDRModConfig.class).getConfig();',
'        if (renderer == null || rendererSource != source) {',
'            if (renderer != null) {',
'                renderer.close();',
'            }',
'            renderer = new ColorTransformRenderer(source, "Flashback");',
'            rendererSource = source;',
'        }',
'        renderer.updateColorTransformUniforms(config.replayUIBrightness, 0, Enums.Primaries.BT2020, Enums.TransferFunction.ST2084_PQ);',
'        renderer.render();',
'        return renderer.getDstTexture();',
'    }',
'}',
''
].join('\n');
writeFileSync(file, source);
console.log('created', file);
const modFile = join(COMMON, 'HDRMod.java');
const raw = readFileSync(modFile, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const anchor = '    public static void init() {';
if (raw.split(anchor).length - 1 !== 1) throw new Error('HDRMod.init() anchor matched ' + (raw.split(anchor).length - 1) + ' times');
const replacement = anchor + eol + '        FlashbackHdrBridge.tryRegister();';
let text = raw.replace(anchor, replacement);
if (!text.includes('xyz.rrtt217.HDRMod.compat.flashback.FlashbackHdrBridge')) {
  const importAnchor = 'import xyz.rrtt217.HDRMod.config.HDRModConfig;';
  if (text.split(importAnchor).length - 1 !== 1) throw new Error('import anchor matched ' + (text.split(importAnchor).length - 1) + ' times');
  text = text.replace(importAnchor, 'import xyz.rrtt217.HDRMod.compat.flashback.FlashbackHdrBridge;' + eol + importAnchor);
}
writeFileSync(modFile, text);
console.log('registered bridge from HDRMod.init()');

# 会话记录分析：Bun 内核 vs Python 内核

数据来源：本机 `~/.prime/agent/sessions/*.jsonl`（真实会话，非合成基准）。
分析脚本：`python3 scripts/fork/kernel_session_stats.py`

## 0. 结论先行

1. **真实会话里，看不到内核替换带来的提速。** 唯一同口径的切片（相同 bash 命令）
   是 Python 中位 29.0ms vs Bun 31.5ms，差异在噪声内；真实耗时由命令本身和模型延迟
   决定，内核那层是毫秒级。
2. **反算全语料**：按分类耗时差的上界估算，8,700 个 Python 单元格总共能省
   **不到 10 秒**；匹配到相同命令的那部分节省约为 0。
3. **会话记录里真正发生的提速在别处**：旧 daemon（0.10.1）+ 系统代理时期，
   两轮对话 35.0s / 44.7s（各带 `Connection error.` 重试）；换成 fork daemon +
   provider `bypassProxy` 后，同样 provider/模型的两轮是 **2.82s / 2.20s**（约 14×）。
4. Bun 内核的价值是**基础设施**：去掉 235MB 的 Python venv、启动/快照更快、
   空闲内存更低；不是端到端加速。

## 1. 口径

- 单元格 = `toolResult`，工具名属于内核别名（`python_repl`/`bun_repl`/…），
  取 `details.durationMs`。
- 分类：`bash_trivial`（单条 echo/pwd/true 等）、`bash_other`（其它 shell）、
  `file_or_net`、`import`、`await`、`wait`（sleep/setTimeout）、
  `pure_short`（≤2 行）、`pure_multi`。
- 只有一侧存在的类别不做对比；**唯一同口径**的是“单条 bash 命令且命令字符串相同”。

## 2. 语料

| | Python 内核 | Bun 内核 |
| --- | ---: | ---: |
| 会话数 | 48 | 7 |
| 内核单元格 | 8,700 | ≈400 |
| 每会话单元格（均值） | 181.2 | ≈57 |
| 单元格总耗时 | 517.8 min | ≈34 min |

Bun 的语料基本是**同一个重活会话**（Nuxt/CloudBase：装依赖、构建、网络、刻意等待），
Python 的语料是几个月的混合工作。两者不是同一份工作，这一点决定了下面的读法。

## 3. 同口径对比：相同命令

单条 bash 命令、命令字符串完全一致的单元格：

| 命令 | Python (n / 中位) | Bun (n / 中位) |
| --- | ---: | ---: |
| `bun test test/ 2>&1 \| tail -3` | 8 / 20.5ms | 2 / 30.0ms |
| `bun test test/ 2>&1 \| tail -4` | 2 / 24.5ms | 7 / 47.0ms |
| `bun test test/ 2>&1 \| tail -5` | 2 / 2576.5ms | 2 / 32.0ms |
| `bun test test/ 2>&1 \| tail -6` | 3 / 52.0ms | 4 / 27.5ms |
| `bun test test/ 2>&1 \| tail -8` | 5 / 51.0ms | 1 / 30.0ms |
| `ls -la` | 3 / 37.0ms | 2 / 15.5ms |
| **合计** | **23 / 29.0ms** | **18 / 31.5ms** |

结论：在这批真实、可比的单元格上，Bun 没有更快（+8.6%，样本小、差异不显著）。
原因很直接：单元格耗时主要是子进程启动和命令本身，解释器开销只占很小一部分。

## 4. 分类耗时（仅作上下文，不可直接比）

| 类别 | Python n / 中位 / p90 | Bun n / 中位 / p90 |
| --- | ---: | ---: |
| pure_short | 276 / 7.0ms / 785ms | 0 / — |
| pure_multi | 392 / 98.5ms / 831ms | 0 / — |
| import | 381 / 5.0ms / 2.9s | 9 / 1.0ms / 2ms |
| await | 640 / 15.0ms / 3.7s | 27 / 5.0ms / 95ms |
| file_or_net | 2,533 / 4.0ms / 466ms | 101 / 437ms / 5.4s |
| bash_trivial | 94 / 113.5ms / 10.0s | 1 / 501ms |
| bash_other | 4,277 / 191ms / 9.3s | 252 / 38ms / 18.0s |
| wait | 107 / 11ms / 75.0s | 6 / 15.1s / 65.9s |

`import`/`await` 上 Bun 更快（1ms vs 5ms、5ms vs 15ms），符合“没有模块导入/事件循环开销”
的预期；`file_or_net`、`bash_*` 的差异来自做的事不同（Python 语料里有大量 curl/dig
网络探测），不能归因于内核。

## 5. 反算：到底省了多少时间

- **同口径部分（相同命令）**：23 vs 18 个单元格，Bun 反而 +2.5ms/格 → 节省 ≈ 0。
- **上界估算**：把 `import`（381 格 × 4ms）与 `await`（640 格 × 10ms）的差值全部算作
  内核收益，也只有 **≈ 7.9 秒**；`bash` 两类按同口径应为 0。
- 换句话说：即使把全语料换成 Bun 内核，**总节省 < 10 秒**，分布在几个月、8,700 个单元格里，
  单轮不可感知。

## 6. 错误率（语言迁移的真实代价）

| | 错误单元格 | 占比 |
| --- | ---: | ---: |
| Python | 204 / 8,700 | **2.3%** |
| Bun | 17 / ≈400 | **4.3%** |

Bun 侧的错误主要来自切换初期模型继续写 Python（`SyntaxError`/`ReferenceError`）。
这是会话记录里**唯一显著变差的指标**；prompt 层与卡片分发的修复针对它，续接旧
Python 会话仍会复发，建议切换后开新会话。

## 7. 会话记录里真正的提速

同一 provider（commandcode / `z-ai/glm-5.3-flash`）、同一类提问，前后对比：

| 状态 | 轮次耗时 | 失败 |
| --- | ---: | --- |
| 旧 daemon（0.10.1）+ 系统代理 | **35.0s / 44.7s** | 每轮 1–2 次 `Connection error.` |
| fork daemon + `bypassProxy` | **2.82s / 2.20s** | 0 |

约 **14×**。同期用 `PI_REQUEST_TIMING=1` 实测的首字节也印证：走代理 9.6s → 绕过 1.9s。

所以“提速”这件事的正确归因是：

1. 换掉 18 天前的旧 daemon（否则 TUI 的请求全跑在 0.10.1 的 worker 上）；
2. 给 provider 配 `bypassProxy`；
3. 内核替换负责的是启动、内存、快照和“不再需要 Python venv”这类基础设施收益，
   不是一轮对话的墙钟时间。

## 8. 复现

```bash
python3 scripts/fork/kernel_session_stats.py
```

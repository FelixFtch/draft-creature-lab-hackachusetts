"""PPO in the style of rsl_rl (Rudin et al. 2021), CPU-only torch.

* Actor and critic are separate ELU MLPs; the critic additionally sees a few
  privileged simulator quantities (asymmetric actor-critic, never exported).
* Running observation normalisers (mean / (std + eps), like rsl_rl's
  EmpiricalNormalization) are updated during rollouts and baked into the ONNX.
* GAE; time-outs bootstrap with the critic's value of the true terminal
  observation; clipped surrogate, clipped value loss, entropy bonus, gradient
  clipping and the adaptive learning rate driven by the policy KL.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import math

import torch
from torch import nn


@dataclass
class PPOConfig:
    steps_per_env: int = 24
    epochs: int = 5
    minibatches: int = 4
    gamma: float = 0.99
    lam: float = 0.95
    clip: float = 0.2
    value_coef: float = 1.0
    entropy_coef: float = 0.005
    learning_rate: float = 1e-3
    desired_kl: float = 0.01
    max_grad_norm: float = 1.0
    actor_hidden: tuple = (256, 128, 64)
    critic_hidden: tuple = (256, 128, 64)
    init_std: float = 0.6
    min_std: float = 0.05

    def to_dict(self) -> dict:
        return {k: list(v) if isinstance(v, tuple) else v for k, v in asdict(self).items()}

    @classmethod
    def from_dict(cls, d: dict) -> 'PPOConfig':
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: tuple(v) if isinstance(v, list) else v for k, v in d.items() if k in known})


class Normalizer(nn.Module):
    """Running mean/std (parallel Welford in float64); output (x - mean) / (std + eps)."""

    def __init__(self, size: int, eps: float = 1e-2):
        super().__init__()
        self.eps = eps
        self.register_buffer('mean', torch.zeros(size, dtype=torch.float64))
        self.register_buffer('var', torch.ones(size, dtype=torch.float64))
        self.register_buffer('count', torch.zeros((), dtype=torch.float64))

    @torch.no_grad()
    def update(self, x: torch.Tensor) -> None:
        x = x.to(torch.float64)
        n = x.shape[0]
        if n == 0:
            return
        batch_mean = x.mean(0)
        batch_var = x.var(0, unbiased=False)
        total = self.count + n
        delta = batch_mean - self.mean
        self.mean += delta * n / total
        m2 = self.var * self.count + batch_var * n + delta ** 2 * self.count * n / total
        self.var.copy_(m2 / total)
        self.count.copy_(total)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return ((x - self.mean.to(x.dtype)) / (self.var.sqrt().to(x.dtype) + self.eps))

    def affine(self) -> tuple[torch.Tensor, torch.Tensor]:
        """(mean, scale) with normalised = (x - mean) * scale, in float32."""
        return self.mean.float(), (1.0 / (self.var.sqrt() + self.eps)).float()


def mlp(n_in: int, hidden: tuple, n_out: int, out_gain: float) -> nn.Sequential:
    layers, last = [], n_in
    for h in hidden:
        linear = nn.Linear(last, h)
        nn.init.orthogonal_(linear.weight, gain=math.sqrt(2))
        nn.init.zeros_(linear.bias)
        layers += [linear, nn.ELU()]
        last = h
    out = nn.Linear(last, n_out)
    nn.init.orthogonal_(out.weight, gain=out_gain)
    nn.init.zeros_(out.bias)
    layers.append(out)
    return nn.Sequential(*layers)


class ActorCritic(nn.Module):
    def __init__(self, n_obs: int, n_critic: int, n_act: int, cfg: PPOConfig):
        super().__init__()
        self.actor = mlp(n_obs, tuple(cfg.actor_hidden), n_act, 0.01)
        self.critic = mlp(n_critic, tuple(cfg.critic_hidden), 1, 1.0)
        self.log_std = nn.Parameter(torch.full((n_act,), math.log(cfg.init_std)))
        self.obs_norm = Normalizer(n_obs)
        self.critic_norm = Normalizer(n_critic)
        self.min_log_std = math.log(cfg.min_std)

    def std(self) -> torch.Tensor:
        return self.log_std.clamp(min=self.min_log_std).exp()

    def policy_mean(self, raw_obs: torch.Tensor) -> torch.Tensor:
        """Deterministic action from raw (unnormalised) observations: what ONNX exports."""
        return self.actor(self.obs_norm(raw_obs))


@dataclass
class Batch:
    obs: torch.Tensor
    critic_obs: torch.Tensor
    actions: torch.Tensor
    log_prob: torch.Tensor
    values: torch.Tensor
    returns: torch.Tensor
    advantages: torch.Tensor
    mu: torch.Tensor
    sigma: torch.Tensor


class Storage:
    def __init__(self, steps: int, n_envs: int, n_obs: int, n_critic: int, n_act: int):
        T, N = steps, n_envs
        self.obs = torch.zeros(T, N, n_obs)
        self.critic_obs = torch.zeros(T, N, n_critic)
        self.actions = torch.zeros(T, N, n_act)
        self.log_prob = torch.zeros(T, N)
        self.values = torch.zeros(T, N)
        self.rewards = torch.zeros(T, N)
        self.dones = torch.zeros(T, N)
        self.mu = torch.zeros(T, N, n_act)
        self.sigma = torch.zeros(T, N, n_act)
        self.returns = torch.zeros(T, N)
        self.advantages = torch.zeros(T, N)
        self.step = 0

    def compute_returns(self, last_values: torch.Tensor, gamma: float, lam: float) -> None:
        gae = torch.zeros_like(last_values)
        T = self.rewards.shape[0]
        for t in reversed(range(T)):
            next_values = last_values if t == T - 1 else self.values[t + 1]
            not_done = 1.0 - self.dones[t]
            delta = self.rewards[t] + gamma * next_values * not_done - self.values[t]
            gae = delta + gamma * lam * not_done * gae
            self.returns[t] = gae + self.values[t]
        adv = self.returns - self.values
        self.advantages = (adv - adv.mean()) / (adv.std() + 1e-8)

    def minibatches(self, count: int, epochs: int, generator: torch.Generator | None = None):
        T, N = self.rewards.shape
        total = T * N
        size = total // count
        flat = lambda x: x.reshape(total, *x.shape[2:])
        tensors = [flat(t) for t in (self.obs, self.critic_obs, self.actions, self.log_prob, self.values,
                                     self.returns, self.advantages, self.mu, self.sigma)]
        for _ in range(epochs):
            perm = torch.randperm(total, generator=generator)
            for i in range(count):
                idx = perm[i * size:(i + 1) * size]
                yield Batch(*[t[idx] for t in tensors])


class PPO:
    def __init__(self, model: ActorCritic, cfg: PPOConfig):
        self.model = model
        self.cfg = cfg
        self.lr = cfg.learning_rate
        # foreach: one multi-tensor kernel per step instead of a Python loop per parameter.
        self.optimizer = torch.optim.Adam(model.parameters(), lr=self.lr, foreach=True)

    @torch.no_grad()
    def act(self, obs: torch.Tensor, critic_obs: torch.Tensor, update_norm: bool = True):
        m = self.model
        if update_norm:
            m.obs_norm.update(obs)
            m.critic_norm.update(critic_obs)
        obs_n, crit_n = m.obs_norm(obs), m.critic_norm(critic_obs)
        mu = m.actor(obs_n)
        log_std = m.log_std.clamp(min=m.min_log_std)
        sigma = log_std.exp().expand_as(mu)
        noise = torch.randn_like(mu)
        action = mu + sigma * noise
        # Gaussian log-density written out (torch.distributions adds ~1 ms per call here).
        log_prob = (-0.5 * noise ** 2 - log_std - 0.5 * math.log(2 * math.pi)).sum(-1)
        value = m.critic(crit_n).squeeze(-1)
        return action, log_prob, value, mu, sigma, obs_n, crit_n

    @torch.no_grad()
    def value(self, critic_obs: torch.Tensor) -> torch.Tensor:
        return self.model.critic(self.model.critic_norm(critic_obs)).squeeze(-1)

    def update(self, storage: Storage) -> dict:
        cfg, m = self.cfg, self.model
        stats = {'value_loss': 0.0, 'surrogate': 0.0, 'entropy': 0.0, 'kl': 0.0}
        n = 0
        for b in storage.minibatches(cfg.minibatches, cfg.epochs):
            mu = m.actor(b.obs)
            sigma = m.std().expand_as(mu)
            dist = torch.distributions.Normal(mu, sigma)
            log_prob = dist.log_prob(b.actions).sum(-1)
            entropy = dist.entropy().sum(-1)
            value = m.critic(b.critic_obs).squeeze(-1)
            with torch.no_grad():
                kl = torch.sum(torch.log(sigma / b.sigma) + (b.sigma ** 2 + (b.mu - mu) ** 2) / (2 * sigma ** 2) - 0.5, -1).mean()
                if cfg.desired_kl > 0:
                    if kl > 2 * cfg.desired_kl:
                        self.lr = max(1e-5, self.lr / 1.5)
                    elif 0 < kl < cfg.desired_kl / 2:
                        self.lr = min(1e-2, self.lr * 1.5)
                    for group in self.optimizer.param_groups:
                        group['lr'] = self.lr
            ratio = torch.exp(log_prob - b.log_prob)
            surrogate = torch.max(-b.advantages * ratio,
                                  -b.advantages * torch.clamp(ratio, 1 - cfg.clip, 1 + cfg.clip)).mean()
            clipped = b.values + (value - b.values).clamp(-cfg.clip, cfg.clip)
            value_loss = torch.max((value - b.returns) ** 2, (clipped - b.returns) ** 2).mean()
            loss = surrogate + cfg.value_coef * value_loss - cfg.entropy_coef * entropy.mean()
            self.optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(m.parameters(), cfg.max_grad_norm)
            self.optimizer.step()
            stats['value_loss'] += float(value_loss.detach())
            stats['surrogate'] += float(surrogate.detach())
            stats['entropy'] += float(entropy.mean().detach())
            stats['kl'] += float(kl)
            n += 1
        stats = {k: v / max(1, n) for k, v in stats.items()}
        stats['lr'] = self.lr
        stats['std'] = float(m.std().mean().detach())
        return stats

    def state_dict(self) -> dict:
        return {'model': self.model.state_dict(), 'optimizer': self.optimizer.state_dict(), 'lr': self.lr}

    def load_state_dict(self, sd: dict) -> None:
        self.model.load_state_dict(sd['model'])
        self.optimizer.load_state_dict(sd['optimizer'])
        self.lr = float(sd['lr'])
        for group in self.optimizer.param_groups:
            group['lr'] = self.lr

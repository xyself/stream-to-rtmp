"""斗鱼 API 调用模块"""

from typing import TypedDict

import httpx

from astrbot.api import logger


class RoomInfo(TypedDict, total=False):
    """房间信息类型"""
    owner_name: str
    nickname: str
    room_name: str


class DouyuAPI:
    """斗鱼 API 封装类

    提供获取直播间信息等功能。
    使用公开的 betard 接口，无需鉴权。
    """

    BASE_URL = "https://www.douyu.com/betard"
    TIMEOUT = 10.0

    @classmethod
    async def fetch_room_info(cls, room_id: int) -> RoomInfo | None:
        """从斗鱼获取直播间信息

        Args:
            room_id: 斗鱼直播间房间号

        Returns:
            包含 owner_name, nickname, room_name 的字典，获取失败返回 None
        """
        url = f"{cls.BASE_URL}/{room_id}"
        try:
            async with httpx.AsyncClient(timeout=cls.TIMEOUT) as client:
                response = await client.get(url)
                if response.status_code == 200:
                    data = response.json()
                    room = data.get("room", {})
                    return RoomInfo(
                        owner_name=room.get("owner_name", ""),
                        nickname=room.get("nickname", ""),
                        room_name=room.get("room_name", ""),
                    )
        except Exception as e:
            logger.warning(f"获取斗鱼直播间 {room_id} 信息失败: {e}")
        return None

    @classmethod
    async def get_streamer_name(cls, room_id: int) -> str:
        """获取主播名称

        Args:
            room_id: 斗鱼直播间房间号

        Returns:
            主播名称，获取失败返回空字符串
        """
        info = await cls.fetch_room_info(room_id)
        if info:
            return info.get("owner_name") or info.get("nickname") or ""
        return ""


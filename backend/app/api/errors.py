"""API 异常边界：统一安全响应，同时保留服务端脱敏定位日志。"""

import logging

from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from app.core.errors import INVALID_REQUEST, describe_error

logger = logging.getLogger(__name__)


class ErrorResponse(BaseModel):
    """公开错误结构；不包含异常正文、请求输入或供应商响应。"""

    detail: str
    code: str


class SafeAPIRoute(APIRoute):
    """在响应开始前拦截异常；流开始后的错误由生成器单独转为 SSE 帧。"""

    def get_route_handler(self):
        original_handler = super().get_route_handler()

        async def handle(request):
            try:
                return await original_handler(request)
            except HTTPException:
                # 仅透传应用主动声明的 404、413 等错误，不覆盖原有业务语义。
                raise
            except RequestValidationError:
                # 默认校验详情可能包含用户原始输入，不回传 input、ctx 或请求正文。
                return JSONResponse(
                    status_code=INVALID_REQUEST.status_code,
                    content={"detail": INVALID_REQUEST.message, "code": INVALID_REQUEST.code},
                )
            except Exception as error:
                info = describe_error(error)
                logger.log(
                    logging.WARNING if info.status_code < 500 else logging.ERROR,
                    "API 请求处理失败：路由=%s，错误代码=%s",
                    self.name,
                    info.code,
                    exc_info=True,
                )
                # 在路由边界完成处理，避免异常继续交给服务器并重复输出原始详情。
                return JSONResponse(
                    status_code=info.status_code,
                    content={"detail": info.message, "code": info.code},
                )

        return handle
